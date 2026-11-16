// src/pkjs/index.js: the wiring to the phone's XMLHttpRequest, geolocation, localStorage and to AppMessage.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fx = require('./helpers/fixtures');
const { tierOfRequest, tierResponses, summarise } = require('./helpers/phone');
const protocol = require('../src/common/protocol');

const INDEX = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
const GLOBALS = ['Pebble', 'XMLHttpRequest', 'navigator', 'localStorage'];

// Loads index.js into a fake PebbleKit JS environment. `respond(xhr)` answers each request (default: recorded).
function boot(options) {
  const opts = options || {};
  const env = { handlers: {}, sent: [], requests: [], storage: {}, gpsOptions: null, logs: [] };
  const log = console.log;
  console.log = text => { env.logs.push(String(text)); };  // index.js logs through the phone's console
  const data = fx.load();
  const saved = {};
  for (const name of GLOBALS) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  define('Pebble', {
    addEventListener: (name, fn) => { env.handlers[name] = fn; },
    sendAppMessage: (dict, ack, nack) => { env.sent.push(dict.PAYLOAD); (opts.nack && opts.nack(dict.PAYLOAD) ? nack : ack)({}); }
  });
  define('XMLHttpRequest', class {
    constructor() { this.headers = {}; env.requests.push(this); }
    open(method, url, async) { this.method = method; this.url = url; this.async = async; }
    setRequestHeader(name, value) {
      if (opts.forbidUserAgent && name === 'User-Agent') throw new Error('Refused to set unsafe header');
      this.headers[name] = value;
    }
    getResponseHeader(name) { return (this.responseHeaders || {})[name] || null; }
    send(body) {
      this.body = body;
      if (opts.respond && opts.respond(this) !== undefined) return;
      this.status = 200;
      if (/interpreter$/.test(this.url)) this.responseText = tierResponses()[tierOfRequest(this)];
      else if (this.url.includes('api.adsb.lol')) this.responseText = data.planesText;
      else { this.status = 404; this.responseText = ''; }
      this.onload();
    }
  });
  define('navigator', {
    geolocation: opts.noGeolocation ? undefined : {
      getCurrentPosition: (ok, err, o) => {
        env.gpsOptions = o;
        if (opts.gpsError) err({ code: opts.gpsError }); else ok({ coords: { latitude: fx.POSITION.lat, longitude: fx.POSITION.lon } });
      }
    }
  });
  define('localStorage', {
    getItem: key => (key in env.storage ? env.storage[key] : null),
    setItem: (key, value) => { env.storage[key] = String(value); }
  });
  delete require.cache[INDEX];
  require(INDEX);
  env.restore = () => {
    console.log = log;
    for (const name of GLOBALS) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name];
    }
  };
  env.hello = () => env.handlers.appmessage({ payload: { CMD: 1, VAL: (228 << 22) | (200 << 12) | 20 } });
  return env;
}

test('ready fetches nothing; the hello brings aircraft and roads to the watch', t => {
  const env = boot();
  t.after(env.restore);
  env.handlers.ready();
  assert.equal(env.requests.length, 0);
  assert.equal(env.sent.length, 0);
  env.hello();
  const s = summarise(env.sent);
  assert.deepEqual(s.statuses.slice(0, 2), ['Locating...', 'Fetching planes...']);
  assert.ok(s.views >= 1);
  assert.ok(s.planes[1] > 20);
  assert.equal(env.requests.filter(r => /interpreter$/.test(r.url)).length, 4);
  assert.ok(env.storage.roads_v1.length > 1000, 'roads are kept in localStorage');
  assert.deepEqual(env.gpsOptions, { enableHighAccuracy: false, timeout: 30000, maximumAge: 600000 });
});

test('messages before ready are ignored', t => {
  const env = boot();
  t.after(env.restore);
  env.hello();
  assert.equal(env.sent.length, 0);
});

test('requests: asynchronous, with timeouts, form-encoded queries and nothing that needs a CORS preflight', t => {
  const env = boot();
  t.after(env.restore);
  env.handlers.ready();
  env.hello();
  const overpass = env.requests.find(r => /interpreter$/.test(r.url));
  assert.equal(overpass.method, 'POST');
  assert.equal(overpass.async, true);
  assert.equal(overpass.timeout, 30000);
  assert.equal(overpass.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(overpass.body, /^data=%5Bout%3Ajson%5D/);
  const planes = env.requests.find(r => r.url.includes('api.adsb.lol'));
  assert.equal(planes.method, 'GET');
  assert.equal(planes.timeout, 12000);
  assert.equal(planes.body, undefined);
  for (const r of env.requests) {
    assert.deepEqual(Object.keys(r.headers).filter(h => h !== 'User-Agent' && h !== 'Content-Type'), []);
  }
});

test('a runtime that forbids setting User-Agent still gets its requests out', t => {
  const env = boot({ forbidUserAgent: true });
  t.after(env.restore);
  env.handlers.ready();
  env.hello();
  assert.ok(summarise(env.sent).views >= 1);
});

test('position errors reach the watch with their code; a phone without geolocation says so', t => {
  const denied = boot({ gpsError: 1 });
  denied.handlers.ready();
  denied.hello();
  assert.deepEqual(summarise(denied.sent).errors, ['GPS err 1']);
  denied.restore();
  const none = boot({ noGeolocation: true });
  t.after(none.restore);
  none.handlers.ready();
  none.hello();
  assert.deepEqual(summarise(none.sent).errors, ['no geolocation']);
});

test('HTTP failures, timeouts and network errors are told apart', t => {
  const failing = how => {
    const env = boot({ respond: xhr => { if (xhr.url.includes('api.adsb.lol')) { how(xhr); return true; } return undefined; } });
    env.handlers.ready();
    env.hello();
    env.restore();
    return summarise(env.sent).errors;
  };
  assert.deepEqual(failing(xhr => { xhr.status = 503; xhr.onload(); }), ['planes: HTTP 503']);
  assert.deepEqual(failing(xhr => xhr.ontimeout()), ['planes: timeout']);
  assert.deepEqual(failing(xhr => xhr.onerror()), ['planes: network']);
  // a request reports once, whatever the runtime fires afterwards
  assert.deepEqual(failing(xhr => { xhr.onerror(); xhr.ontimeout(); xhr.status = 200; xhr.responseText = '{}'; xhr.onload(); }), ['planes: network']);
});

test('Retry-After of a 429 keeps that Overpass endpoint out of the next road fetch', t => {
  let limited = true;
  const env = boot({
    respond: xhr => {
      if (!/overpass-api\.de/.test(xhr.url) || !limited) return undefined;
      xhr.status = 429;
      xhr.responseHeaders = { 'Retry-After': '600' };
      xhr.onload();
      return true;
    }
  });
  t.after(env.restore);
  env.handlers.ready();
  env.hello();
  const first = env.requests.filter(r => /interpreter$/.test(r.url)).map(r => new URL(r.url).host);
  assert.equal(first[0], 'overpass-api.de');
  assert.ok(first.slice(1).every(h => h !== 'overpass-api.de'), 'the other tiers went elsewhere');
  assert.equal(first.length, 5);
});

test('a message the watch does not acknowledge is retried and then skipped; the rest still arrives', async t => {
  let refused = 0;
  const env = boot({ nack: payload => payload[0] === protocol.PAY_BEGIN && refused++ < 3 });
  t.after(env.restore);
  env.handlers.ready();
  env.hello();
  await new Promise(resolve => setTimeout(resolve, 1300));  // two retries, half a second apart
  const types = env.sent.map(p => p[0]);
  assert.equal(types.filter(x => x === protocol.PAY_BEGIN).length >= 3, true);
  assert.ok(types.includes(protocol.PAY_END));
});

test('roads come from the map tiles when they answer: binary requests, no Overpass', t => {
  const mvt = require('./helpers/mvt');
  const roads = require('../src/common/roads');
  const tile = mvt.tile([{ name: 'transportation', features: [{ props: { class: 'motorway' }, lines: [[[0, 2048], [4096, 2048]]] }] }]);
  const env = boot({
    respond: xhr => {
      if (xhr.url === roads.TILE_SOURCE) xhr.responseText = JSON.stringify({ tiles: ['https://tiles.test/{z}/{x}/{y}.pbf'] });
      else if (/^https:\/\/tiles\.test\//.test(xhr.url)) xhr.response = tile.buffer;
      else return undefined;
      xhr.status = 200;
      xhr.onload();
      return true;
    }
  });
  t.after(env.restore);
  env.handlers.ready();
  env.hello();
  const tiles = env.requests.filter(r => /^https:\/\/tiles\.test\//.test(r.url));
  assert.equal(tiles.length, 9);
  assert.ok(tiles.every(r => r.method === 'GET' && r.responseType === 'arraybuffer' && r.timeout === roads.TILE_TIMEOUT_MS));
  assert.equal(env.requests.find(r => r.url === roads.TILE_SOURCE).responseType, undefined);
  assert.equal(env.requests.filter(r => /interpreter$/.test(r.url)).length, 0);
  assert.ok(env.storage.roads_v1.length > 100, 'roads are kept in localStorage');
  assert.ok(summarise(env.sent).views >= 1);
});
