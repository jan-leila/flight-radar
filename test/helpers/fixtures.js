// The recorded responses in test/fixtures/ and the scenario every reference comparison runs
// (tools/reference-streams.js records it from the original app, test/parity.test.js replays it here).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'fixtures');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');

// Minneapolis, 2026-11-14: every primary-or-larger road within about six miles, and the aircraft within 40.
const POSITION = { lat: 44.9778, lon: -93.2650 };
const TRACED = ['ac9abc', 'a057c7'];  // aircraft with a recorded trace

let cache = null;
function load() {
  if (cache) return cache;
  const planesText = read('adsb-msp.json');
  const traces = {};
  for (const hex of TRACED) traces[hex] = read('trace-' + hex + '.json');
  cache = {
    overpassText: zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'overpass-msp.json.gz'))).toString('utf8'),
    planesText,
    traces,
    // the moment the aircraft were recorded: the clock every replay starts at
    clock: JSON.parse(planesText).now
  };
  return cache;
}

const SCREENS = [{ name: 'emery', width: 200, height: 228 }, { name: 'gabbro', width: 260, height: 260 }];
const ZOOMS = [20, 40, 5, 10];        // 20 first: the watch starts there
const REFRESH_AFTER_MS = 31000;

module.exports = { POSITION, TRACED, SCREENS, ZOOMS, REFRESH_AFTER_MS, load };
