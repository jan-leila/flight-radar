// src/common/roads.js: the road store, the per-tier Overpass queries with fail-over, and the stored form.
const test = require('node:test');
const assert = require('node:assert/strict');
const roads = require('../src/common/roads');
const fx = require('./helpers/fixtures');
const { httpError, tierResponses, TIERS } = require('./helpers/phone');

const way = (...points) => ({ type: 'way', id: 1, geometry: points.map(([lat, lon]) => ({ lat, lon })) });

test('store: ways are appended per tier; anything without geometry is skipped', () => {
  const store = roads.createStore();
  const added = roads.addElements(store, 'trunk', [
    way([44.1, -93.1], [44.2, -93.2]),
    { type: 'node', lat: 1, lon: 2 },
    { type: 'way', id: 2 },
    { type: 'way', id: 3, geometry: [] },
    null,
    way([45, -94])
  ]);
  assert.equal(added, 2);
  assert.deepEqual(store.tiers.trunk, { lat: [44.1, 44.2, 45], lon: [-93.1, -93.2, -94], ends: [2, 3] });
  assert.equal(roads.wayCount(store), 2);
  assert.equal(roads.wayCount(roads.createStore()), 0);
  assert.equal(roads.addElements(store, 'primary', undefined), 0);
});

test('tierOf: link roads belong to their road; other highways have no tier', () => {
  assert.equal(roads.tierOf('motorway_link'), 'motorway');
  assert.equal(roads.tierOf('secondary'), 'secondary');
  assert.equal(roads.tierOf('residential'), null);
  assert.equal(roads.tierOf(undefined), null);
});

test('tierQuery: one tier and its links, 40 miles around, geometry without tags', () => {
  assert.equal(roads.tierQuery('trunk', 44.9778, -93.2650),
    '[out:json][timeout:60];way["highway"~"^(trunk|trunk_link)$"](44.398,-94.085,45.558,-92.445);out ids geom;');
});

test('statusOfError maps failures to the codes the watch explains', () => {
  const S = roads.STATUS;
  assert.equal(roads.statusOfError(httpError('timeout')), S.TIMEOUT);
  assert.equal(roads.statusOfError(httpError('network')), S.NETWORK);
  assert.equal(roads.statusOfError(httpError('HTTP 504', 504)), S.HTTP);
  assert.equal(roads.statusOfError(new SyntaxError('Unexpected token <')), S.PARSE);
  assert.equal(roads.statusOfError(Object.assign(new Error('Overpass cooldown'), { cooldown: true })), S.COOLDOWN);
  assert.equal(roads.statusOfError(null), S.PARSE);
});

// A fetcher whose endpoints answer from `answers[url]` (a function or a value); records the URLs asked.
function fetcherWith(answers, clock) {
  const asked = [];
  const fetcher = roads.createFetcher({
    endpoints: Object.keys(answers),
    now: () => clock.now,
    http: (req, cb) => {
      asked.push(req);
      let a = answers[req.url];
      if (typeof a === 'function') a = a(req);
      if (a instanceof Error) cb(a); else cb(null, a);
    }
  });
  return { fetcher, asked };
}

const OK = JSON.stringify({ elements: [way([1, 2], [3, 4])] });

test('fetchTier posts the query, form-encoded, with a per-endpoint timeout', () => {
  const { fetcher, asked } = fetcherWith({ 'https://a/': OK }, { now: 0 });
  let result;
  fetcher.fetchTier('primary', 44.9778, -93.2650, (err, elements) => { result = { err, elements }; });
  assert.equal(result.err, null);
  assert.equal(result.elements.length, 1);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, 'POST');
  assert.equal(asked[0].timeout, roads.TIER_TIMEOUT_MS);
  assert.equal(decodeURIComponent(asked[0].body.replace(/^data=/, '')), roads.tierQuery('primary', 44.9778, -93.2650));
});

test('fetchTier moves on to the next endpoint on any failure and then starts with the one that worked', () => {
  const { fetcher, asked } = fetcherWith({
    'https://a/': httpError('timeout'),
    'https://b/': '<html>busy</html>',
    'https://c/': OK,
    'https://d/': OK
  }, { now: 0 });
  let calls = 0;
  fetcher.fetchTier('motorway', 1, 2, (err, elements) => { calls++; assert.equal(err, null); assert.equal(elements.length, 1); });
  assert.deepEqual(asked.map(r => r.url), ['https://a/', 'https://b/', 'https://c/']);
  fetcher.fetchTier('trunk', 1, 2, err => { calls++; assert.equal(err, null); });
  assert.deepEqual(asked.map(r => r.url).slice(3), ['https://c/']);
  assert.equal(calls, 2);
});

test('fetchTier reports the last failure when every endpoint fails', () => {
  const { fetcher, asked } = fetcherWith({ 'https://a/': httpError('network'), 'https://b/': httpError('HTTP 504', 504) }, { now: 0 });
  let error;
  fetcher.fetchTier('motorway', 1, 2, err => { error = err; });
  assert.equal(error.message, 'HTTP 504');
  assert.equal(asked.length, 2);
  // a response without an elements array is a failure too
  const bad = fetcherWith({ 'https://a/': '{"remark":"runtime error"}' }, { now: 0 });
  bad.fetcher.fetchTier('motorway', 1, 2, err => { error = err; });
  assert.equal(roads.statusOfError(error), roads.STATUS.PARSE);
});

test('an endpoint that answers 429 is left alone for Retry-After seconds (5 minutes by default, 30 at most)', () => {
  const clock = { now: 1000000 };
  const answers = { 'https://a/': httpError('HTTP 429', 429, 60), 'https://b/': httpError('HTTP 429', 429) };
  const { fetcher, asked } = fetcherWith(answers, clock);
  let error;
  const run = () => fetcher.fetchTier('motorway', 1, 2, err => { error = err; });
  run();
  assert.equal(asked.length, 2);
  assert.equal(error.message, 'HTTP 429');
  run();
  assert.equal(asked.length, 2, 'both endpoints are cooling down: nothing is asked');
  assert.equal(error.cooldown, true);
  assert.equal(roads.statusOfError(error), roads.STATUS.COOLDOWN);
  clock.now += 61000;
  answers['https://a/'] = OK;
  run();
  assert.deepEqual(asked.map(r => r.url).slice(2), ['https://a/']);
  assert.equal(error, null);
  clock.now += 240000;                       // 301 s after the 429 of b
  answers['https://a/'] = httpError('timeout');
  answers['https://b/'] = httpError('HTTP 429', 429, 99999);
  run();
  assert.deepEqual(asked.map(r => r.url).slice(3), ['https://a/', 'https://b/']);
  clock.now += 1799000;
  run();
  assert.deepEqual(asked.map(r => r.url).slice(5), ['https://a/'], 'b: capped at 30 minutes, not over yet');
  clock.now += 2000;
  run();
  assert.deepEqual(asked.map(r => r.url).slice(6), ['https://a/', 'https://b/']);
});

test('the default endpoints are distinct https Overpass interpreters', () => {
  assert.ok(roads.ENDPOINTS.length >= 3);
  assert.equal(new Set(roads.ENDPOINTS).size, roads.ENDPOINTS.length);
  for (const url of roads.ENDPOINTS) assert.match(url, /^https:\/\/.+\/api\/interpreter$/);
});

function fixtureStore() {
  const store = roads.createStore();
  for (const tier of TIERS) roads.addElements(store, tier, JSON.parse(tierResponses()[tier]).elements);
  return store;
}

test('pack/unpack is lossless on real OSM data and small enough to store', () => {
  const store = fixtureStore();
  assert.ok(roads.wayCount(store) > 6000);
  const packed = roads.pack(store);
  assert.deepEqual(Object.keys(packed), TIERS);
  const back = roads.unpack(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(back, store);  // the very same doubles, not just close ones
  const chars = JSON.stringify(packed).length;
  const points = TIERS.reduce((n, t) => n + store.tiers[t].lat.length, 0);
  assert.ok(chars / points < 7, `${(chars / points).toFixed(1)} characters per point`);
  assert.ok(chars < fx.load().overpassText.length / 6);
});

test('pack handles empty tiers, single points and jumps across the globe', () => {
  const store = roads.createStore();
  roads.addElements(store, 'motorway', [way([-89.9999999, -179.9999999], [89.9999999, 179.9999999]), way([0, 0])]);
  roads.addElements(store, 'secondary', [way([44.9778123, -93.2650456], [44.9778124, -93.2650455], [44.9778123, -93.2650456])]);
  assert.deepEqual(roads.unpack(roads.pack(store)), store);
  assert.deepEqual(roads.unpack(roads.pack(roads.createStore())), roads.createStore());
});

test('pack refuses to round: coordinates finer than 1e-7 degree are not packed', () => {
  const store = roads.createStore();
  roads.addElements(store, 'primary', [way([44.12345678, -93.1], [44.2, -93.2])]);
  assert.equal(roads.pack(store), null);
});

test('unpack throws on anything malformed', () => {
  const packed = roads.pack(fixtureStore());
  assert.throws(() => roads.unpack(null));
  assert.throws(() => roads.unpack({ motorway: 'AA==' }));
  assert.throws(() => roads.unpack(Object.assign({}, packed, { trunk: packed.trunk.slice(0, 40) })), /truncated/);
  assert.throws(() => roads.unpack(Object.assign({}, packed, { trunk: '!!!!' })), /base64/);
});
