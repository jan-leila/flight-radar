// src/common/session.js: what the phone sends for each command of the watch, with roads and aircraft arriving
// in every order, failing, and coming back from storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./helpers/fixtures');
const { createPhone, summarise, decodeBitmap, httpError, tierOfRequest, TIERS } = require('./helpers/phone');
const protocol = require('../src/common/protocol');
const roads = require('../src/common/roads');
const raster = require('../src/common/raster');
const session = require('../src/common/session');

const EMERY = fx.SCREENS[0];
const isOverpass = req => /interpreter$/.test(req.url);
const isPlanes = req => req.url.includes('api.adsb.lol');
const roadPixels = s => decodeBitmap(s.rle, EMERY.width, EMERY.height).filter(c => c === raster.COLOR_ROAD).length;
const roadStatus = s => s.begin[11];

test('nothing is fetched or sent before the watch says hello', () => {
  const phone = createPhone();
  assert.equal(phone.sent.length, 0);
  assert.equal(phone.requests.length, 0);
});

test('hello: aircraft first on an empty map, then the major roads, then everything', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  assert.deepEqual(summarise(phone.take()).statuses, ['Locating...', 'Fetching planes...']);
  assert.deepEqual(phone.pending.map(p => (isOverpass(p.req) ? tierOfRequest(p.req) : 'planes')), ['motorway', 'planes']);

  // the aircraft arrive while the first road tier is still on its way
  phone.answer(isPlanes);
  const first = summarise(phone.take());
  assert.deepEqual(first.types.slice(0, 2), [protocol.PAY_BEGIN, protocol.PAY_BITMAP_BEGIN]);
  assert.deepEqual(first.types.slice(-3), [protocol.PAY_PLANES, protocol.PAY_END, protocol.PAY_STATUS]);
  assert.deepEqual(first.statuses, ['Fetching roads...']);
  assert.equal(roadStatus(first), roads.STATUS.OK, 'still loading is not a road problem');
  assert.equal(roadPixels(first), 0);
  assert.ok(first.planes[1] > 20, 'aircraft are shown without waiting for roads');

  phone.answer();                               // motorways alone do not trigger a new map
  assert.equal(phone.take().length, 0);
  phone.answer();                               // trunk roads: the major roads are in
  const major = summarise(phone.take());
  assert.equal(major.views, 1);
  assert.ok(roadPixels(major) > 500);
  assert.deepEqual(major.statuses, ['Fetching roads...']);

  phone.answer();                               // primary
  assert.equal(phone.take().length, 0);
  phone.answer();                               // secondary: complete
  const all = summarise(phone.take());
  assert.equal(all.views, 1);
  assert.ok(roadPixels(all) > roadPixels(major));
  assert.deepEqual(all.statuses, [], 'nothing left to wait for');
  assert.equal(phone.pending.length, 0);
  assert.deepEqual(phone.requests.filter(isOverpass).map(tierOfRequest), TIERS);
});

test('roads that arrive before the aircraft go out with the first view', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.take();
  while (phone.answer(isOverpass)) { /* all four tiers */ }
  assert.equal(phone.take().length, 0, 'no view without aircraft');
  phone.answer(isPlanes);
  const view = summarise(phone.take());
  assert.equal(view.views, 1);
  assert.ok(roadPixels(view) > 1000);
  assert.deepEqual(view.statuses, []);
});

test('a map update waits until the watch has the previous messages', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.answer(isPlanes);
  phone.take();
  phone.backlog = 12;                           // the first view is still being delivered
  phone.drain();
  assert.equal(phone.take().length, 0);
  phone.advance(1000);
  assert.equal(phone.take().length, 0);
  phone.backlog = 0;
  phone.advance(1000);
  const view = summarise(phone.take());
  assert.equal(view.views, 1, 'one view with everything, not one per tier');
  assert.ok(roadPixels(view) > 1000);
});

test('the map is rendered for the screen the watch reports', () => {
  for (const screen of fx.SCREENS) {
    const phone = createPhone();
    phone.hello(screen, 20);
    phone.drain();
    const views = phone.take();
    const view = summarise(views.slice(views.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)));
    const total = view.rle.reduce((n, v, i) => (i % 2 ? n + v : n), 0);
    assert.equal(total, screen.width * screen.height, screen.name);
  }
});

test('refresh: aircraft only, and every refresh of the watch (30 s apart) is answered', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.advance(900);   // the answer takes a moment, so the next refresh comes less than 30 s after it
  phone.drain();
  phone.take();
  const asked = phone.requests.length;
  phone.advance(10000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  assert.equal(phone.requests.length, asked, 'too soon');
  phone.advance(19100);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  assert.equal(phone.requests.length, asked + 1);
  assert.ok(isPlanes(phone.requests[asked]));
  phone.drain();
  assert.deepEqual(summarise(phone.take()).types, [protocol.PAY_PLANES, protocol.PAY_END]);
});

test('a refresh while the roads are loading does not start a second road fetch, and repeats the reminder', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.answer(isPlanes);
  phone.take();
  phone.advance(31000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  assert.equal(phone.requests.filter(isOverpass).length, 1);
  phone.answer(isPlanes);
  const refresh = summarise(phone.take());
  assert.deepEqual(refresh.types, [protocol.PAY_PLANES, protocol.PAY_END, protocol.PAY_STATUS]);
  assert.deepEqual(refresh.statuses, ['Fetching roads...']);
});

test('a second hello while locating or loading starts nothing twice', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.hello(EMERY, 20);
  assert.equal(phone.requests.filter(isOverpass).length, 1);
  assert.equal(phone.requests.filter(isPlanes).length, 2);
  phone.drain();
  assert.equal(phone.requests.filter(isOverpass).length, 4);
});

test('zoom: the same roads rendered again, nothing fetched', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.drain();
  const at20 = phone.take();
  const asked = phone.requests.length;
  phone.watch({ CMD: protocol.CMD_VIEW, VAL: 5 });
  const at5 = summarise(phone.take());
  assert.equal(phone.requests.length, asked);
  assert.equal(at5.views, 1);
  assert.equal(at5.begin[9], 5);
  assert.notDeepEqual(at5.rle, summarise(at20.slice(at20.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN))).rle);
  // zooming before anything is known starts the first fetch at that zoom
  const cold = createPhone();
  cold.watch({ CMD: protocol.CMD_VIEW, VAL: 40 });
  cold.drain();
  assert.equal(summarise(cold.take()).begin[9], 40);
});

test('selection: the path so far at once, the recorded trace when it arrives, the path with every refresh', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.drain();
  phone.take();
  phone.select('ac9abc');
  const now = summarise(phone.take());
  assert.equal(now.trails.length, 1);
  assert.deepEqual(now.trails[0].slice(0, 5), [protocol.PAY_TRAIL, 0xac, 0x9a, 0xbc, 1], 'one point: where it was seen');
  assert.equal(phone.pending.length, 1);
  assert.match(phone.pending[0].req.url, /trace_recent_ac9abc\.json$/);
  phone.drain();
  const traced = summarise(phone.take());
  assert.equal(traced.trails.length, 1);
  assert.equal(traced.trails[0][4], 16, 'the newest 16 points of the trace');

  phone.select('ac9abc');                       // again: no second trace request
  assert.equal(phone.pending.length, 0);
  assert.equal(summarise(phone.take()).trails.length, 1);

  phone.advance(31000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  phone.drain();
  const refresh = summarise(phone.take());
  const records = refresh.planes.length - 2 - refresh.planes[1] * 36;
  assert.equal(records, 16 * 4, 'the selected plane carries its path');
});

test('a plane without a recorded trace keeps the path the phone has seen', () => {
  const phone = createPhone();
  phone.hello(EMERY, 20);
  phone.drain();
  phone.take();
  phone.select('ab8ca5');
  phone.drain();
  assert.equal(summarise(phone.take()).trails.length, 1, 'no second message after the 404');
  assert.ok(phone.logs.some(l => /trace ab8ca5: HTTP 404/.test(l)));
});

test('no position: the error goes to the watch and the next refresh tries again', () => {
  const phone = createPhone({ position: new Error('GPS err 1') });
  phone.hello(EMERY, 20);
  const failed = summarise(phone.take());
  assert.deepEqual(failed.statuses, ['Locating...']);
  assert.deepEqual(failed.errors, ['GPS err 1']);
  assert.equal(phone.requests.length, 0);
  phone.position = fx.POSITION;
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  phone.drain();
  assert.ok(summarise(phone.take()).views >= 1);
});

test('aircraft failing: the error goes to the watch, the roads keep loading, the next refresh shows both', () => {
  let down = true;
  const phone = createPhone({ respond: req => (isPlanes(req) && down ? httpError('timeout') : undefined) });
  phone.hello(EMERY, 20);
  phone.drain();
  const failed = summarise(phone.take());
  assert.deepEqual(failed.errors, ['planes: timeout']);
  assert.equal(failed.views, 0);
  assert.equal(phone.requests.filter(isOverpass).length, 4);
  down = false;
  phone.advance(31000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  phone.drain();
  const view = summarise(phone.take());
  assert.equal(view.views, 1, 'the map was never sent, so the refresh brings it');
  assert.ok(roadPixels(view) > 1000);
});

test('garbage instead of aircraft is an error, not a crash', () => {
  const phone = createPhone({ respond: req => (isPlanes(req) ? '<html>' : undefined) });
  phone.hello(EMERY, 20);
  phone.drain();
  assert.equal(summarise(phone.take()).errors.length, 1);
});

for (const [name, failure, status] of [
  ['timeout', httpError('timeout'), roads.STATUS.TIMEOUT],
  ['no network', httpError('network'), roads.STATUS.NETWORK],
  ['HTTP error', httpError('HTTP 504', 504), roads.STATUS.HTTP],
  ['rate limit', httpError('HTTP 429', 429), roads.STATUS.HTTP],
  ['unparseable answer', '<html>', roads.STATUS.PARSE]
]) {
  test(`roads failing (${name}): every endpoint is tried, then the watch gets the reason with the aircraft`, () => {
    const phone = createPhone({ respond: req => (isOverpass(req) ? failure : undefined) });
    phone.hello(EMERY, 20);
    phone.drain();
    assert.equal(phone.requests.filter(isOverpass).length, roads.ENDPOINTS.length);
    assert.deepEqual([...new Set(phone.requests.filter(isOverpass).map(r => r.url))], roads.ENDPOINTS);
    const all = phone.take();
    const last = summarise(all.slice(all.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)));
    assert.equal(roadStatus(last), status);
    assert.ok(last.planes[1] > 20);
    assert.deepEqual(last.statuses, []);
  });
}

test('one endpoint down: the next one serves every tier and is asked first from then on', () => {
  const phone = createPhone({ respond: req => (req.url === roads.ENDPOINTS[0] ? httpError('network') : undefined) });
  phone.hello(EMERY, 20);
  phone.drain();
  const urls = phone.requests.filter(isOverpass).map(r => r.url);
  assert.deepEqual(urls, [roads.ENDPOINTS[0], roads.ENDPOINTS[1], roads.ENDPOINTS[1], roads.ENDPOINTS[1], roads.ENDPOINTS[1]]);
  const all = phone.take();
  assert.equal(roadStatus(summarise(all.slice(all.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)))), roads.STATUS.OK);
});

test('failed roads are retried on a refresh two minutes later, only for the tiers still missing', () => {
  let down = false;
  const phone = createPhone({ respond: req => (isOverpass(req) && down ? httpError('timeout') : undefined) });
  phone.hello(EMERY, 20);
  phone.answer(isPlanes);
  phone.answer(isOverpass);                     // motorway
  phone.answer(isOverpass);                     // trunk
  down = true;
  phone.drain();                                // primary fails everywhere
  const all = phone.take();
  const failed = summarise(all.slice(all.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)));
  assert.equal(roadStatus(failed), roads.STATUS.TIMEOUT);
  assert.ok(roadPixels(failed) > 500, 'the tiers that did arrive are drawn');

  const asked = phone.requests.filter(isOverpass).length;
  phone.advance(60000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  phone.drain();
  assert.equal(phone.requests.filter(isOverpass).length, asked, 'not yet');
  phone.take();

  down = false;
  phone.advance(61000);
  phone.watch({ CMD: protocol.CMD_REFRESH_PLANES, VAL: 0 });
  phone.drain();
  assert.deepEqual(phone.requests.filter(isOverpass).slice(asked).map(tierOfRequest), ['primary', 'secondary']);
  const again = phone.take();
  const fixed = summarise(again.slice(again.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)));
  assert.equal(roadStatus(fixed), roads.STATUS.OK);
  assert.ok(roadPixels(fixed) > roadPixels(failed));
});

test('a region without roads is reported as such and remembered', () => {
  const phone = createPhone({ respond: req => (isOverpass(req) ? '{"elements":[]}' : undefined) });
  phone.hello(EMERY, 20);
  phone.drain();
  const all = phone.take();
  assert.equal(roadStatus(summarise(all.slice(all.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)))), roads.STATUS.EMPTY_REGION);
  const later = createPhone({ storage: phone.storage });
  later.hello(EMERY, 20);
  later.drain();
  assert.equal(later.requests.filter(isOverpass).length, 0);
  assert.equal(roadStatus(summarise(later.take())), roads.STATUS.EMPTY_REGION);
});

// The complete view a fresh phone ends up sending for the fixtures.
function completeView(phone) {
  const all = phone.take();
  return summarise(all.slice(all.map(m => m[0]).lastIndexOf(protocol.PAY_BEGIN)));
}

test('the roads are stored: the next launch sends the identical map without asking Overpass', () => {
  const first = createPhone();
  first.hello(EMERY, 20);
  first.drain();
  const fresh = completeView(first);
  const stored = first.storage[session.STORAGE_KEY];
  assert.ok(stored.length < 400000, stored.length + ' characters stored');

  const second = createPhone({ storage: { [session.STORAGE_KEY]: stored } });
  second.hello(EMERY, 20);
  assert.deepEqual(summarise(second.sent).statuses, ['Locating...', 'Cache hit, planes...']);
  second.drain();
  assert.equal(second.requests.filter(isOverpass).length, 0);
  const cached = completeView(second);
  assert.deepEqual(cached.rle, fresh.rle, 'pixel for pixel');
  assert.deepEqual(cached.begin, fresh.begin);
  assert.deepEqual(cached.planes, fresh.planes);
});

test('stored roads are used within a mile of where they were fetched, centred there', () => {
  const first = createPhone();
  first.hello(EMERY, 20);
  first.drain();
  const near = createPhone({ storage: first.storage, position: { lat: fx.POSITION.lat + 0.005, lon: fx.POSITION.lon } });
  near.hello(EMERY, 20);
  near.drain();
  assert.equal(near.requests.filter(isOverpass).length, 0);
  assert.deepEqual(completeView(near).begin, completeView(first).begin);
});

test('stored roads are fetched anew after a move, after a week, and on a forced refresh', () => {
  const first = createPhone();
  first.hello(EMERY, 20);
  first.drain();

  const moved = createPhone({ storage: Object.assign({}, first.storage), position: { lat: fx.POSITION.lat + 0.05, lon: fx.POSITION.lon } });
  moved.hello(EMERY, 20);
  moved.drain();
  assert.equal(moved.requests.filter(isOverpass).length, 4);

  const old = createPhone({ storage: Object.assign({}, first.storage) });
  old.now += session.ROADS_TTL_MS + 1;
  old.hello(EMERY, 20);
  old.drain();
  assert.equal(old.requests.filter(isOverpass).length, 4);

  const forced = createPhone({ storage: Object.assign({}, first.storage) });
  forced.watch({ CMD: protocol.CMD_REFRESH_ALL, VAL: 10 });
  forced.drain();
  assert.equal(forced.requests.filter(isOverpass).length, 4);
  assert.equal(completeView(forced).begin[9], 10);
});

test('after a move with Overpass down, the stored map is shown where it was fetched, marked as cached', () => {
  const first = createPhone();
  first.hello(EMERY, 20);
  first.drain();
  const home = completeView(first);
  const away = createPhone({
    storage: first.storage,
    position: { lat: fx.POSITION.lat + 0.05, lon: fx.POSITION.lon },
    respond: req => (isOverpass(req) ? httpError('network') : undefined)
  });
  away.hello(EMERY, 20);
  away.drain();
  const view = completeView(away);
  assert.equal(roadStatus(view), roads.STATUS.CACHE);
  assert.deepEqual(view.begin.slice(1, 9), home.begin.slice(1, 9), 'centred on the stored position');
  assert.deepEqual(view.rle, home.rle);
});

test('storage that is full, corrupt or from another version is survived', () => {
  const full = createPhone({ storageLimit: 1000 });
  full.hello(EMERY, 20);
  full.drain();
  assert.ok(completeView(full).rle.length > 1000);
  assert.ok(full.logs.some(l => /roads not stored/.test(l)));
  assert.equal(full.storage[session.STORAGE_KEY], undefined);

  for (const bad of ['{', 'null', '{"v":99,"lat":1,"lon":2}', '{"v":1,"lat":1,"lon":2,"roads":{"motorway":"AA"}}', '[]', '"x"']) {
    const phone = createPhone({ storage: { [session.STORAGE_KEY]: bad } });
    phone.hello(EMERY, 20);
    phone.drain();
    assert.equal(phone.requests.filter(isOverpass).length, 4, bad);
    assert.equal(roadStatus(completeView(phone)), roads.STATUS.OK, bad);
  }
});

test('unknown and malformed commands are ignored', () => {
  const phone = createPhone();
  phone.watch({});
  phone.watch({ CMD: 77, VAL: 1 });
  phone.watch({ PAYLOAD: [1, 2, 3, 4] });
  phone.session.handle(null);
  assert.equal(phone.sent.length, 0);
  assert.equal(phone.requests.length, 0);
});
