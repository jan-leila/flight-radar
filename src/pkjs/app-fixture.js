// Alternative PebbleKit JS entry for testing the whole app without the network:
//   PKJS_ENTRY=src/pkjs/app-fixture.js pebble build
// Used by tools/test-app-emulator.sh. ES5. Replaces XMLHttpRequest and the position with canned ones and then
// loads the real entry (index.js), so everything from the session down to the watch runs as it ships. Every two
// seconds it logs what was requested so far, 'APP-FIXTURE seen planes=1 roads=motorway,trunk trace=0 unknown=0':
// a log reader that attaches late still learns what happened.

var town = require('./fixture-town');

var GLOBAL = (function () { return this; })();

var PLANES = { ac: [
  { hex: 'ac9abc', flight: 'DAL2349 ', r: 'N911DQ', t: 'B739', alt_baro: 825, gs: 146.3, track: 300, lat: 45.0100, lon: -93.2200 },
  { hex: 'a057c7', r: 'N121DU', t: 'BCS1', alt_baro: 1675, gs: 131, track: 40, lat: 45.0000, lon: -93.1800 },
  { hex: 'aa7f09', flight: 'UAL1144 ', r: 'N77579', t: 'B39M', alt_baro: 15000, gs: 291, track: 90, lat: 44.8900, lon: -93.4500 },
  { hex: 'ac486a', flight: 'SWA1687 ', r: 'N8905Q', t: 'B38M', alt_baro: 35000, gs: 452, track: 200, lat: 44.8200, lon: -93.0600 },
  { hex: 'ab8ca5', flight: 'SCX9200 ', alt_baro: 'ground', gs: 18, track: 180, lat: 44.9300, lon: -93.1500 }
] };

function trace() {
  var points = [];
  var i;
  for (i = 0; i < 12; i++) points.push([i * 20, 44.9100 + i * 0.0085, -93.0800 - i * 0.0120]);
  return { icao: 'ac9abc', timestamp: Date.now() / 1000 - 300, trace: points };
}

var seen = { planes: 0, roads: [], trace: 0, unknown: 0 };

function answer(method, url, body) {
  var query = decodeURIComponent(String(body || ''));
  var tier = /\^\((\w+)\|/.exec(query);
  if (/interpreter$/.test(url) && tier) {
    seen.roads.push(tier[1]);
    return { elements: town.elements(tier[1]) };
  }
  if (url.indexOf('https://api.adsb.lol/v2/') === 0) {
    seen.planes++;
    return PLANES;
  }
  if (/trace_recent_ac9abc\.json$/.test(url)) {
    seen.trace++;
    return trace();
  }
  // No map tiles in this town: the roads have to come from Overpass, as when the tiles cannot be had.
  if (url.indexOf('https://tiles.') === 0) return null;
  seen.unknown++;
  return null;
}

function FakeRequest() {}
FakeRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
FakeRequest.prototype.setRequestHeader = function () {};
FakeRequest.prototype.getResponseHeader = function () { return null; };
FakeRequest.prototype.send = function (body) {
  var request = this;
  setTimeout(function () {
    var data = answer(request.method, request.url, body);
    request.status = data ? 200 : 404;
    request.responseText = data ? JSON.stringify(data) : '';
    request.onload();
  }, 200);
};

GLOBAL.XMLHttpRequest = FakeRequest;
navigator.geolocation.getCurrentPosition = function (ok) {
  setTimeout(function () { ok({ coords: { latitude: town.CENTER.lat, longitude: town.CENTER.lon } }); }, 50);
};
try { localStorage.removeItem('roads_v1'); } catch (e) { /* no storage: nothing to forget */ }

setInterval(function () {
  console.log('APP-FIXTURE seen planes=' + seen.planes + ' roads=' + seen.roads.join(',') + ' trace=' + seen.trace + ' unknown=' + seen.unknown);
}, 2000);
require('./index');
