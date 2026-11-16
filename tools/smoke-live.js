// Runs the real phone-side pipeline against the live services (adsb.lol, the map tiles, Overpass) and reports what the watch
// would get. Nothing is mocked except the watch: every message is "delivered" at once.
//
// usage: node tools/smoke-live.js [lat lon] [--zoom MI] [--screen WxH] [--png FILE] [--overpass]
//   default: Minneapolis, 20 mi, 200x228 (emery). --png writes the final map with the aircraft marked;
//   --overpass leaves the map tiles out, so that the roads come from Overpass.
'use strict';
const fs = require('fs');
const protocol = require('../src/common/protocol');
const { createSession } = require('../src/common/session');
const roads = require('../src/common/roads');
const png = require('./lib/png-diff');

const args = process.argv.slice(2);
const option = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const zoom = Number(option('--zoom', 20));
const [width, height] = option('--screen', '200x228').split('x').map(Number);
const pngFile = option('--png', null);
const noTiles = args.includes('--overpass') && args.splice(args.indexOf('--overpass'), 1).length > 0;
const lat = args.length >= 2 ? Number(args[0]) : 44.9778;
const lon = args.length >= 2 ? Number(args[1]) : -93.2650;

const started = Date.now();
const stamp = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6) + 's';
const say = text => console.log(stamp() + '  ' + text);

// The same request shape src/pkjs/index.js builds with XMLHttpRequest.
function http(req, cb) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeout);
  const t0 = Date.now();
  fetch(req.url, {
    method: req.method,
    body: req.body,
    headers: Object.assign({ 'User-Agent': 'plane-watch (Pebble watchapp)' }, req.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    signal: controller.signal
  }).then(async res => {
    const text = req.binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    clearTimeout(timer);
    say(`${req.method} ${new URL(req.url).host} -> ${res.status}, ${(text.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (res.ok) return cb(null, text);
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.retryAfter = parseInt(res.headers.get('retry-after'), 10) || null;
    cb(err);
  }, e => {
    clearTimeout(timer);
    const message = e.name === 'AbortError' ? 'timeout' : 'network';
    say(`${req.method} ${new URL(req.url).host} -> ${message}`);
    cb(new Error(message));
  });
}

const PALETTE = v => [((v >> 4) & 3) * 85, ((v >> 2) & 3) * 85, (v & 3) * 85];
let lastView = null;
let stored = false;
let current = null;
const storage = {};

function deliver(m) {
  const text = () => Buffer.from(m.slice(1)).toString('latin1');
  if (m[0] === protocol.PAY_STATUS) say('status: ' + text());
  else if (m[0] === protocol.PAY_ERROR) say('ERROR: ' + text());
  else if (m[0] === protocol.PAY_BEGIN) current = { roadStatus: m[11], rle: [], chunks: 0 };
  else if (m[0] === protocol.PAY_BITMAP_CHUNK) { current.rle.push(...m.slice(1)); current.chunks++; }
  else if (m[0] === protocol.PAY_PLANES) {
    const planes = [];
    for (let at = 2; at + 36 <= m.length; at += 36 + m[at + 35] * 4) {
      planes.push({ x: Buffer.from(m).readInt16LE(at + 3), y: Buffer.from(m).readInt16LE(at + 5), name: Buffer.from(m.slice(at + 9, at + 17)).toString('latin1').replace(/\0+$/, '') });
    }
    if (current) current.planes = planes; else say(`refresh: ${planes.length} aircraft`);
  } else if (m[0] === protocol.PAY_END && current) {
    const pixels = new Uint8Array(width * height).fill(0xC0);
    let pos = 0;
    for (let i = 0; i + 1 < current.rle.length; i += 2) { pixels.fill(current.rle[i], pos, pos + current.rle[i + 1]); pos += current.rle[i + 1]; }
    const road = pixels.filter(v => v === 0xD5).length;
    say(`view: road status ${current.roadStatus}, ${road} road pixels, bitmap ${current.rle.length} B in ${current.chunks} messages, ` +
        `${current.planes.length} aircraft (${current.planes.slice(0, 4).map(p => p.name || '?').join(', ')}...)`);
    lastView = Object.assign(current, { pixels });
    current = null;
    // Done with the complete map on the watch, or when the roads failed (the app would try again two minutes later).
    if (stored || lastView.roadStatus !== 0) finish();
  }
}

const session = createSession({
  http,
  tileSource: noTiles ? undefined : roads.TILE_SOURCE,
  locate: cb => cb(null, lat, lon),
  storage: { get: key => (key in storage ? storage[key] : null), set: (key, value) => { storage[key] = value; say(`stored ${(value.length / 1024).toFixed(0)} KB of roads`); stored = true; if (lastView && !current) finish(); } },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  send: deliver,
  backlog: () => 0,
  log: text => say('log: ' + text)
});

let done = false;
function finish() {
  if (done) return;
  done = true;
  setTimeout(() => {
    if (pngFile && lastView) {
      const data = new Uint8Array(width * height * 4);
      lastView.pixels.forEach((v, i) => data.set([...PALETTE(v), 255], i * 4));
      for (const p of lastView.planes) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = (width >> 1) + p.x + dx, y = (height >> 1) + p.y + dy;
          if (x >= 0 && x < width && y >= 0 && y < height) data.set([255, 85, 0, 255], (y * width + x) * 4);
        }
      }
      fs.writeFileSync(pngFile, png.encode({ width, height, data }));
      say('wrote ' + pngFile);
    }
    process.exit(lastView && lastView.roadStatus === 0 ? 0 : 1);
  }, 500);
}

say(`hello from a ${width}x${height} watch at ${lat}, ${lon}, ${zoom} mi`);
session.handle(protocol.decodeWatchMessage({ CMD: protocol.CMD_HELLO, VAL: (height << 22) | (width << 12) | zoom }));
// Every endpoint failing takes two minutes per tier at most.
setTimeout(() => { say('gave up waiting for the roads'); finish(); }, 9 * 60 * 1000);
