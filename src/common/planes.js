// Aircraft: the adsb.lol responses, the list sent to the watch and the flight paths (CONTRACTS.md §5). ES5.

var MAX_WIRE_PLANES = 48;                 // one PAY_PLANES message has to fit the watch's inbox
var MAX_TRAIL = 16;                       // trail points per plane on the wire and on the watch
var PHONE_TRAIL_CAP = 80;                 // points kept per plane on the phone, thinned out when sent
var TRAIL_TTL_MS = 30 * 60 * 1000;
var SAME_PLACE_DEG = 1e-5;
var MILES_PER_NM = 1.151;

function planesUrl(lat, lon, radiusMi) {
  return 'https://api.adsb.lol/v2/lat/' + lat.toFixed(4) + '/lon/' + lon.toFixed(4) +
         '/dist/' + Math.round(radiusMi / MILES_PER_NM);
}

function traceUrl(hex) {
  return 'https://globe.adsb.lol/data/traces/' + hex.slice(-2) + '/trace_recent_' + hex + '.json';
}

function trimmed(v) { return String(v || '').replace(/^\s+|\s+$/g, ''); }

// adsb.lol /v2 response -> [{hex, lat, lon, alt (ft, 0 on the ground), gs (kt), track (deg), callsign, tail, type}].
// Aircraft without a position or a real ICAO address are dropped: without the address a plane cannot be
// selected or given a flight path.
function parsePlanes(data) {
  var raw = (data && data.ac) || [];
  var out = [];
  var i, a, hex, callsign;
  for (i = 0; i < raw.length; i++) {
    a = raw[i];
    if (!a || typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    hex = String(a.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex) || hex === '000000') continue;
    callsign = trimmed(a.flight);
    // Some transponders send a filler such as "00000000" or "@@@@@@@@"; the watch then shows the address.
    if (/^(.)\1+$/.test(callsign)) callsign = '';
    out.push({
      hex: hex,
      lat: a.lat,
      lon: a.lon,
      alt: typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : 0,
      gs: typeof a.gs === 'number' ? a.gs : 0,
      track: a.track || 0,
      callsign: callsign,
      tail: trimmed(a.r),
      type: trimmed(a.t)
    });
  }
  return out;
}

// The `max` planes closest to (lat0, lon0), closest first.
function nearest(planes, lat0, lon0, max) {
  var k = Math.cos(lat0 * Math.PI / 180);
  var scored = (planes || []).map(function (p) {
    var dLat = p.lat - lat0;
    var dLon = (p.lon - lon0) * k;
    return { plane: p, d2: dLat * dLat + dLon * dLon };
  });
  scored.sort(function (a, b) { return a.d2 - b.d2; });
  return scored.slice(0, max).map(function (s) { return s.plane; });
}

// readsb trace_recent file -> [{lat, lon, ts (ms)}], oldest first.
function parseTrace(data) {
  var out = [];
  var base, i, t;
  if (!data || typeof data.timestamp !== 'number' || !(data.trace instanceof Array)) throw new Error('bad trace');
  base = data.timestamp * 1000;
  for (i = 0; i < data.trace.length; i++) {
    t = data.trace[i];
    if (!t || typeof t[0] !== 'number' || typeof t[1] !== 'number' || typeof t[2] !== 'number') continue;
    out.push({ lat: t[1], lon: t[2], ts: base + t[0] * 1000 });
  }
  return out;
}

// At most `max` entries of `points`: the first, the last and evenly spaced ones in between.
function decimate(points, max) {
  var out, span, i;
  if (points.length <= max) return points;
  out = [points[0]];
  span = points.length - 1;
  for (i = 1; i < max - 1; i++) out.push(points[Math.round(i * span / (max - 1))]);
  out.push(points[points.length - 1]);
  return out;
}

function samePlace(a, b) {
  return Math.abs(a.lat - b.lat) < SAME_PLACE_DEG && Math.abs(a.lon - b.lon) < SAME_PLACE_DEG;
}

// Flight paths by ICAO address, built from the positions seen on each refresh and, once per plane, from its
// recorded trace. `now` is a function returning milliseconds.
function createTrails(now) {
  var trails = {};
  var traced = {};

  function prune() {
    var cutoff = now() - TRAIL_TTL_MS;
    var hex, kept;
    for (hex in trails) {
      kept = trails[hex].filter(function (p) { return p.ts >= cutoff; });
      if (kept.length) {
        trails[hex] = kept;
      } else {
        delete trails[hex];
        delete traced[hex];
      }
    }
  }

  function observe(planes) {
    var ts = now();
    var i, p, trail;
    for (i = 0; i < planes.length; i++) {
      p = planes[i];
      trail = trails[p.hex] || (trails[p.hex] = []);
      if (trail.length && samePlace(trail[trail.length - 1], p)) continue;
      trail.push({ lat: p.lat, lon: p.lon, ts: ts });
      if (trail.length > PHONE_TRAIL_CAP) trail.splice(0, trail.length - PHONE_TRAIL_CAP);
    }
    prune();
  }

  // Merges a recorded trace into the path of `hex`, keeping the newest MAX_TRAIL points of the last half hour.
  function mergeTrace(hex, points) {
    var cutoff = now() - TRAIL_TTL_MS;
    var merged = points.concat(trails[hex] || []);
    var out = [];
    var i;
    merged.sort(function (a, b) { return a.ts - b.ts; });
    for (i = 0; i < merged.length; i++) {
      if (out.length && samePlace(out[out.length - 1], merged[i])) continue;
      out.push(merged[i]);
    }
    out = out.filter(function (p) { return p.ts >= cutoff; });
    trails[hex] = out.slice(Math.max(0, out.length - MAX_TRAIL));
  }

  return {
    observe: observe,
    mergeTrace: mergeTrace,
    // The path of `hex` as sent to the watch: at most MAX_TRAIL points, oldest first.
    wirePoints: function (hex) { return decimate(trails[hex] || [], MAX_TRAIL); },
    // True the first time it is called for a plane (until its path expires): fetch the trace then.
    claimTrace: function (hex) {
      if (traced[hex]) return false;
      traced[hex] = true;
      return true;
    }
  };
}

module.exports = {
  MAX_WIRE_PLANES: MAX_WIRE_PLANES,
  MAX_TRAIL: MAX_TRAIL,
  TRAIL_TTL_MS: TRAIL_TTL_MS,
  planesUrl: planesUrl,
  traceUrl: traceUrl,
  parsePlanes: parsePlanes,
  nearest: nearest,
  parseTrace: parseTrace,
  decimate: decimate,
  createTrails: createTrails
};
