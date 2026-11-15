// src/common/planes.js: adsb.lol responses, the nearest planes, traces and flight paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const planes = require('../src/common/planes');
const fx = require('./helpers/fixtures');

test('request URLs: 40 miles are 35 nautical miles; traces are filed under the last two hex digits', () => {
  assert.equal(planes.planesUrl(44.97781234, -93.265, 40), 'https://api.adsb.lol/v2/lat/44.9778/lon/-93.2650/dist/35');
  assert.equal(planes.traceUrl('ac9abc'), 'https://globe.adsb.lol/data/traces/bc/trace_recent_ac9abc.json');
});

test('parsePlanes normalises the fields the watch shows', () => {
  const out = planes.parsePlanes({ ac: [
    { hex: 'AC9ABC', flight: 'DAL2349 ', r: 'N911DQ', t: 'B739', alt_baro: 825, gs: 146.3, track: 301.2, lat: 44.9, lon: -93.2 },
    { hex: 'ab8ca5', flight: 'SCX9200 ', alt_baro: 'ground', alt_geom: 850, gs: 18.5, lat: 44.88, lon: -93.24 },
    { hex: 'a00001', alt_baro: 'ground', lat: 1, lon: 2 }
  ] });
  assert.deepEqual(out[0], { hex: 'ac9abc', lat: 44.9, lon: -93.2, alt: 825, gs: 146.3, track: 301.2, callsign: 'DAL2349', tail: 'N911DQ', type: 'B739' });
  assert.equal(out[1].alt, 850, 'geometric altitude stands in for a missing barometric one');
  assert.deepEqual(out[2], { hex: 'a00001', lat: 1, lon: 2, alt: 0, gs: 0, track: 0, callsign: '', tail: '', type: '' });
});

test('parsePlanes drops aircraft without a position or a real address, and filler callsigns', () => {
  const out = planes.parsePlanes({ ac: [
    { hex: 'a11111', lat: 1 },
    { hex: '~a2222', lat: 1, lon: 2 },
    { hex: '000000', lat: 1, lon: 2 },
    { lat: 1, lon: 2 },
    null,
    { hex: 'a33333', lat: 1, lon: 2, flight: '00000000' },
    { hex: 'a44444', lat: 1, lon: 2, flight: '@@@@@@@@' },
    { hex: 'a55555', lat: 1, lon: 2, flight: 'AA' },
    { hex: 'a66666', lat: 1, lon: 2, flight: 'A' }
  ] });
  assert.deepEqual(out.map(p => p.hex + ':' + p.callsign), ['a33333:', 'a44444:', 'a55555:', 'a66666:A']);
  assert.deepEqual(planes.parsePlanes({}), []);
  assert.deepEqual(planes.parsePlanes(null), []);
});

test('the recorded response parses: 54 aircraft, all with positions', () => {
  const out = planes.parsePlanes(JSON.parse(fx.load().planesText));
  assert.equal(out.length, 54);
  assert.ok(out.every(p => typeof p.lat === 'number' && /^[0-9a-f]{6}$/.test(p.hex)));
});

test('nearest: closest first, capped, east-west distance scaled by latitude', () => {
  const list = [
    { hex: 'far', lat: 60.5, lon: 10 },
    { hex: 'east', lat: 60, lon: 10.6 },   // 0.6 deg of longitude at 60 N is 0.3 deg worth of distance
    { hex: 'north', lat: 60.4, lon: 10 }
  ];
  assert.deepEqual(planes.nearest(list, 60, 10, 48).map(p => p.hex), ['east', 'north', 'far']);
  assert.deepEqual(planes.nearest(list, 60, 10, 2).map(p => p.hex), ['east', 'north']);
  assert.deepEqual(planes.nearest([], 60, 10, 2), []);
  assert.deepEqual(planes.nearest(null, 60, 10, 2), []);
  assert.equal(list[0].hex, 'far', 'the input is left as it was');
});

test('parseTrace: seconds after the file timestamp become milliseconds; malformed rows are skipped', () => {
  const out = planes.parseTrace({ timestamp: 1000, trace: [[0, 44.1, -93.1, 2000], [12.5, 44.2, -93.2], null, ['x', 1, 2], [20, 44.3]] });
  assert.deepEqual(out, [{ lat: 44.1, lon: -93.1, ts: 1000000 }, { lat: 44.2, lon: -93.2, ts: 1012500 }]);
  assert.throws(() => planes.parseTrace({ trace: [] }), /bad trace/);
  assert.throws(() => planes.parseTrace({ timestamp: 1 }), /bad trace/);
  assert.throws(() => planes.parseTrace(null), /bad trace/);
  assert.equal(planes.parseTrace(JSON.parse(fx.load().traces.ac9abc)).length, 92);
});

test('decimate keeps the ends and spreads the rest evenly', () => {
  const points = Array.from({ length: 33 }, (_, i) => i);
  assert.deepEqual(planes.decimate(points, 5), [0, 8, 16, 24, 32]);
  assert.deepEqual(planes.decimate([1, 2, 3], 5), [1, 2, 3]);
  assert.equal(planes.decimate(Array.from({ length: 80 }, (_, i) => i), 16).length, 16);
});

test('trails grow with each refresh that moved the plane and forget after half an hour', () => {
  let now = 1000000;
  const trails = planes.createTrails(() => now);
  const seen = (lat, lon) => trails.observe([{ hex: 'abc123', lat, lon }]);
  seen(44, -93);
  now += 30000; seen(44, -93);                 // did not move
  now += 30000; seen(44.000001, -93.000001);   // nor this, to five decimals
  now += 30000; seen(44.01, -93);
  assert.deepEqual(trails.wirePoints('abc123'), [{ lat: 44, lon: -93, ts: 1000000 }, { lat: 44.01, lon: -93, ts: 1090000 }]);
  assert.deepEqual(trails.wirePoints('ffffff'), []);
  now = 1000000 + planes.TRAIL_TTL_MS + 1;
  trails.observe([]);
  assert.deepEqual(trails.wirePoints('abc123').map(p => p.ts), [1090000]);
  now += planes.TRAIL_TTL_MS;
  trails.observe([]);
  assert.deepEqual(trails.wirePoints('abc123'), []);
});

test('a long trail is thinned to 16 points for the watch, the phone keeps 80', () => {
  let now = 0;
  const trails = planes.createTrails(() => now);
  for (let i = 0; i < 100; i++) { now += 1000; trails.observe([{ hex: 'abc123', lat: 44 + i * 0.01, lon: -93 }]); }
  const wire = trails.wirePoints('abc123');
  assert.equal(wire.length, planes.MAX_TRAIL);
  assert.equal(wire[0].ts, 21000, 'the oldest 20 of 100 were dropped');
  assert.equal(wire[15].ts, 100000);
});

test('mergeTrace: sorted with what was seen, duplicates dropped, the newest 16 of the last half hour kept', () => {
  let now = 10000000;
  const trails = planes.createTrails(() => now);
  trails.observe([{ hex: 'abc123', lat: 45, lon: -93 }]);
  const trace = [];
  for (let i = 0; i < 30; i++) trace.push({ lat: 44 + i * 0.01, lon: -93, ts: now - planes.TRAIL_TTL_MS - 5 * 60000 + i * 60000 });
  trace.push({ lat: 45, lon: -93, ts: now - 1000 });  // same place as the observed point
  trails.mergeTrace('abc123', trace);
  const wire = trails.wirePoints('abc123');
  assert.equal(wire.length, 16);
  assert.ok(wire.every(p => p.ts >= now - planes.TRAIL_TTL_MS));
  assert.deepEqual(wire.map(p => p.ts), wire.map(p => p.ts).slice().sort((a, b) => a - b));
  assert.equal(wire[15].ts, now - 1000, 'of two points at one place the earlier is kept');
  assert.equal(wire.filter(p => p.lat === 45).length, 1);
});

test('claimTrace is true once per plane until its trail expired', () => {
  let now = 0;
  const trails = planes.createTrails(() => now);
  trails.observe([{ hex: 'abc123', lat: 1, lon: 2 }]);
  assert.equal(trails.claimTrace('abc123'), true);
  assert.equal(trails.claimTrace('abc123'), false);
  assert.equal(trails.claimTrace('def456'), true);
  now += planes.TRAIL_TTL_MS + 1;
  trails.observe([]);
  assert.equal(trails.claimTrace('abc123'), true);
});
