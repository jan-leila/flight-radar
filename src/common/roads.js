// Roads: where they come from (map tiles, else Overpass), the in-memory road store and its compact persistent form
// (CONTRACTS.md §3). ES5.
//
// The tiles come first: a CDN answers in a fraction of a second, where the public Overpass servers can be busy for
// hours. Overpass has the unsimplified geometry and is asked when the tiles cannot be had.
//
// One Overpass request per road tier keeps every response small enough to parse on a phone: the single
// all-tiers query with full tags answers with tens of megabytes for a metropolitan area.

var geo = require('./geo');
var tiles = require('./tiles');

// Drawing order is the reverse of this list (raster.js): motorways end up on top.
var TIERS = ['motorway', 'trunk', 'primary', 'secondary'];

var FETCH_RADIUS_MI = 40;       // one fetch covers every zoom level
var TIER_TIMEOUT_MS = 30000;    // per endpoint and tier
var DEFAULT_COOLDOWN_S = 300;   // after HTTP 429 without Retry-After
var MAX_COOLDOWN_S = 1800;

// TileJSON of the vector tiles (OpenFreeMap: OpenMapTiles schema, no key). Its `tiles` entry names the current
// version of the tile set, so it is read again now and then.
var TILE_SOURCE = 'https://tiles.openfreemap.org/planet';
var TILE_TIMEOUT_MS = 15000;       // per request
var TILE_SOURCE_TTL_MS = 3600000;
var TILE_RETRY_MS = 60000;         // after the tiles failed, Overpass alone is asked for this long
var MAX_TILES = 36;                // more than that (close to a pole) is left to Overpass

var ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

// Shown by the watch as a banner under the map ("[PE4] fetch timeout", ...); sent in PAY_BEGIN.
var STATUS = {
  OK: 0,
  CACHE: 1,
  EMPTY_REGION: 2,
  COOLDOWN: 3,
  TIMEOUT: 4,
  HTTP: 5,
  NETWORK: 6,
  PARSE: 7
};

// OSM coordinates have seven decimals, so a coordinate times this is a whole number.
var UNITS_PER_DEG = 1e7;

function createStore() {
  var tiers = {};
  var i;
  for (i = 0; i < TIERS.length; i++) tiers[TIERS[i]] = { lat: [], lon: [], ends: [] };
  return { tiers: tiers };
}

// Appends ways to a tier. `elements` is the `elements` array of an Overpass JSON response; anything without a
// geometry of at least one point is skipped. Returns the number of ways added.
function addElements(store, tier, elements) {
  var t = store.tiers[tier];
  var added = 0;
  var i, k, el, g;
  for (i = 0; i < (elements || []).length; i++) {
    el = elements[i];
    if (!el || el.type !== 'way' || !el.geometry || !el.geometry.length) continue;
    g = el.geometry;
    for (k = 0; k < g.length; k++) {
      t.lat.push(g[k].lat);
      t.lon.push(g[k].lon);
    }
    t.ends.push(t.lat.length);
    added++;
  }
  return added;
}

function wayCount(store) {
  var n = 0;
  var i;
  for (i = 0; i < TIERS.length; i++) n += store.tiers[TIERS[i]].ends.length;
  return n;
}

function tierOf(highway) {
  var tier = String(highway || '').replace(/_link$/, '');
  return TIERS.indexOf(tier) >= 0 ? tier : null;
}

function tierQuery(tier, lat, lon) {
  var b = geo.bbox(lat, lon, FETCH_RADIUS_MI);
  var box = b[0].toFixed(3) + ',' + b[1].toFixed(3) + ',' + b[2].toFixed(3) + ',' + b[3].toFixed(3);
  return '[out:json][timeout:60];way["highway"~"^(' + tier + '|' + tier + '_link)$"](' + box + ');out ids geom;';
}

function statusOfError(err) {
  var m = String((err && err.message) || '');
  if (err && err.cooldown) return STATUS.COOLDOWN;
  if (m === 'timeout') return STATUS.TIMEOUT;
  if (m === 'network') return STATUS.NETWORK;
  if (/^HTTP /.test(m)) return STATUS.HTTP;
  return STATUS.PARSE;
}

// The roads of every tier within FETCH_RADIUS_MI, from the tiles covering that box:
// cb(err, {<tier>: elements}), elements shaped like Overpass's ({type: 'way', geometry: [{lat, lon}, ...]}).
// One failed tile fails the whole fetch: a map with a hole in it is worse than one that arrives later.
//   deps: { http, now }, state: {template, templateTs} kept between calls
function fetchTiles(deps, source, state, lat, lon, cb) {
  var box = geo.bbox(lat, lon, FETCH_RADIUS_MI);
  var todo = tiles.cover(box);
  var out = {};
  var i;
  for (i = 0; i < TIERS.length; i++) out[TIERS[i]] = [];
  if (todo.length > MAX_TILES) { cb(new Error('too many tiles')); return; }

  function add(tier, lines) {
    var l, k, line, geometry, inside;
    for (l = 0; l < lines.length; l++) {
      line = lines[l];
      geometry = [];
      inside = false;
      for (k = 0; k < line.length; k += 2) {
        geometry.push({ lat: line[k], lon: line[k + 1] });
        if (line[k] >= box[0] && line[k] <= box[2] && line[k + 1] >= box[1] && line[k + 1] <= box[3]) inside = true;
      }
      // The tiles reach beyond the box; lines wholly outside it would only fill the storage.
      if (inside) out[tier].push({ type: 'way', geometry: geometry });
    }
  }

  function next() {
    var tile = todo.shift();
    if (!tile) { cb(null, out); return; }
    deps.http({ method: 'GET', url: tiles.url(state.template, tile), timeout: TILE_TIMEOUT_MS, binary: true },
      function (err, bytes) {
        var decoded, t;
        if (!err) {
          try {
            decoded = tiles.decode(bytes, tile, TIERS);
            for (t = 0; t < TIERS.length; t++) add(TIERS[t], decoded[TIERS[t]]);
          } catch (e) {
            err = e;
          }
        }
        if (err) {
          state.template = null;   // perhaps the tile set was replaced: read the TileJSON again next time
          cb(err);
          return;
        }
        next();
      });
  }

  if (state.template && deps.now() - state.templateTs < TILE_SOURCE_TTL_MS) { next(); return; }
  deps.http({ method: 'GET', url: source, timeout: TILE_TIMEOUT_MS }, function (err, text) {
    var template = null;
    if (!err) {
      try {
        template = JSON.parse(text).tiles[0];
        if (typeof template !== 'string' || template.indexOf('{z}') < 0) throw new Error('no tile address');
      } catch (e) {
        err = e;
      }
    }
    if (err) { cb(err); return; }
    state.template = template;
    state.templateTs = deps.now();
    next();
  });
}

// Fetches roads tier by tier.
//   deps: { http(req, cb(err, body)), now() -> ms, endpoints?, tileSource?, log? }
//     http answers with text, or with the bytes (Uint8Array) of a request that has `binary` set; its errors carry
//     `message` ('timeout' | 'network' | 'HTTP <status>'), `status` and `retryAfter` (seconds).
// fetcher.fetchTier(tier, lat, lon, cb(err, elements)).
// With deps.tileSource (the address of a TileJSON) the first tier asked for a place fetches the tiles for all
// tiers, and every tier is answered from them. When the tiles fail, and without a tileSource, a tier comes from
// Overpass: the endpoints are tried in order, starting with the one that answered last, skipping those that are
// cooling down after a 429. `err.cooldown` is set when every endpoint is cooling down.
function createFetcher(deps) {
  var endpoints = deps.endpoints || ENDPOINTS;
  var cooldownUntil = {};
  var preferred = 0;
  var tileState = { template: null, templateTs: 0 };
  var tileJob = null;   // {key, state: 'loading' | 'ok' | 'failed', byTier, waiting, failedTs}

  function fetchTier(tier, lat, lon, cb) {
    var key = lat + ',' + lon;
    var job = tileJob;

    function answer() {
      var elements = job.state === 'ok' ? job.byTier[tier] : null;
      if (!elements) { fromOverpass(tier, lat, lon, cb); return; }
      delete job.byTier[tier];   // the caller keeps them; a tier asked for again is fetched again
      cb(null, elements);
    }

    if (!deps.tileSource) { fromOverpass(tier, lat, lon, cb); return; }
    if (!job || job.key !== key || (job.state === 'ok' && !job.byTier[tier]) ||
        (job.state === 'failed' && deps.now() - job.failedTs >= TILE_RETRY_MS)) {
      job = tileJob = { key: key, state: 'loading', byTier: null, waiting: [], failedTs: 0 };
      fetchTiles(deps, deps.tileSource, tileState, lat, lon, function (err, byTier) {
        var waiting = job.waiting;
        var i;
        job.waiting = [];
        job.state = err ? 'failed' : 'ok';
        job.byTier = byTier || null;
        job.failedTs = deps.now();
        if (err && deps.log) deps.log('road tiles: ' + err.message + ', asking Overpass');
        for (i = 0; i < waiting.length; i++) waiting[i]();
      });
    }
    if (job.state === 'loading') job.waiting.push(answer); else answer();
  }

  function fromOverpass(tier, lat, lon, cb) {
    var body = 'data=' + encodeURIComponent(tierQuery(tier, lat, lon));
    var lastErr = null;
    var tried = 0;

    function attempt(offset) {
      var index, url;
      if (offset >= endpoints.length) {
        if (!tried) {
          lastErr = new Error('Overpass cooldown');
          lastErr.cooldown = true;
        }
        cb(lastErr);
        return;
      }
      index = (preferred + offset) % endpoints.length;
      url = endpoints[index];
      if (deps.now() < (cooldownUntil[url] || 0)) { attempt(offset + 1); return; }
      tried++;
      deps.http({ method: 'POST', url: url, body: body, timeout: TIER_TIMEOUT_MS }, function (err, text) {
        var data, seconds;
        if (!err) {
          try {
            data = JSON.parse(text);
            if (!data || !data.elements || typeof data.elements.length !== 'number') throw new Error('no elements');
          } catch (e) {
            err = e;
          }
        }
        if (err) {
          if (err.status === 429) {
            seconds = err.retryAfter > 0 ? err.retryAfter : DEFAULT_COOLDOWN_S;
            cooldownUntil[url] = deps.now() + Math.min(seconds, MAX_COOLDOWN_S) * 1000;
          }
          lastErr = err;
          attempt(offset + 1);
          return;
        }
        preferred = index;
        cb(null, data.elements);
      });
    }

    attempt(0);
  }

  return { fetchTier: fetchTier };
}

// ---- persistent form ------------------------------------------------------------------------------------------
// pack(store) -> { motorway: base64, trunk: ..., primary: ..., secondary: ... } or null.
// A tier is the varint way count, then per way the varint point count and zigzag varint deltas (lat, lon) in
// 1e-7 degrees, each relative to the previous point of the tier. The form is lossless: unpack() returns the very
// doubles that were added, so a map drawn from the cache has the same pixels as one drawn from the response.
// pack() returns null instead of rounding when a coordinate has more than seven decimals.

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function pushVarint(out, v) {
  while (v >= 128) {
    out.push((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function zigzag(d) { return d >= 0 ? d * 2 : -d * 2 - 1; }
function unzigzag(z) { return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }

function base64Encode(bytes) {
  var parts = [];
  var chunk = '';
  var i, b0, b1, b2;
  for (i = 0; i < bytes.length; i += 3) {
    b0 = bytes[i];
    b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    chunk += B64.charAt(b0 >> 2) + B64.charAt(((b0 & 3) << 4) | (b1 >> 4)) +
             (i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=') +
             (i + 2 < bytes.length ? B64.charAt(b2 & 63) : '=');
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}

var B64_VALUE = null;

function base64Decode(text) {
  var out = [];
  var i, a, b, c, d;
  if (!B64_VALUE) {
    B64_VALUE = {};
    for (i = 0; i < B64.length; i++) B64_VALUE[B64.charAt(i)] = i;
  }
  for (i = 0; i + 3 < text.length; i += 4) {
    a = B64_VALUE[text.charAt(i)];
    b = B64_VALUE[text.charAt(i + 1)];
    c = B64_VALUE[text.charAt(i + 2)];
    d = B64_VALUE[text.charAt(i + 3)];
    if (a === undefined || b === undefined) throw new Error('bad base64');
    out.push((a << 2) | (b >> 4));
    if (text.charAt(i + 2) === '=') break;
    if (c === undefined) throw new Error('bad base64');
    out.push(((b & 15) << 4) | (c >> 2));
    if (text.charAt(i + 3) === '=') break;
    if (d === undefined) throw new Error('bad base64');
    out.push(((c & 3) << 6) | d);
  }
  return out;
}

function packTier(t) {
  var out = [];
  var prevLat = 0;
  var prevLon = 0;
  var start = 0;
  var w, k, la, lo;
  pushVarint(out, t.ends.length);
  for (w = 0; w < t.ends.length; w++) {
    pushVarint(out, t.ends[w] - start);
    for (k = start; k < t.ends[w]; k++) {
      la = Math.round(t.lat[k] * UNITS_PER_DEG);
      lo = Math.round(t.lon[k] * UNITS_PER_DEG);
      if (la / UNITS_PER_DEG !== t.lat[k] || lo / UNITS_PER_DEG !== t.lon[k]) return null;
      pushVarint(out, zigzag(la - prevLat));
      pushVarint(out, zigzag(lo - prevLon));
      prevLat = la;
      prevLon = lo;
    }
    start = t.ends[w];
  }
  return base64Encode(out);
}

function pack(store) {
  var out = {};
  var i, packed;
  for (i = 0; i < TIERS.length; i++) {
    packed = packTier(store.tiers[TIERS[i]]);
    if (packed === null) return null;
    out[TIERS[i]] = packed;
  }
  return out;
}

function unpackTier(text, t) {
  var bytes = base64Decode(text);
  var pos = 0;
  var lat = 0;
  var lon = 0;
  var ways, w, n, k;

  function varint() {
    var v = 0;
    var scale = 1;
    var b;
    do {
      if (pos >= bytes.length) throw new Error('truncated roads');
      b = bytes[pos++];
      v += (b & 127) * scale;
      scale *= 128;
    } while (b >= 128);
    return v;
  }

  ways = varint();
  for (w = 0; w < ways; w++) {
    n = varint();
    for (k = 0; k < n; k++) {
      lat += unzigzag(varint());
      lon += unzigzag(varint());
      t.lat.push(lat / UNITS_PER_DEG);
      t.lon.push(lon / UNITS_PER_DEG);
    }
    t.ends.push(t.lat.length);
  }
}

// Throws on malformed input.
function unpack(packed) {
  var store = createStore();
  var i;
  if (!packed || typeof packed !== 'object') throw new Error('no packed roads');
  for (i = 0; i < TIERS.length; i++) {
    if (typeof packed[TIERS[i]] !== 'string') throw new Error('missing tier ' + TIERS[i]);
    unpackTier(packed[TIERS[i]], store.tiers[TIERS[i]]);
  }
  return store;
}

module.exports = {
  TIERS: TIERS,
  STATUS: STATUS,
  ENDPOINTS: ENDPOINTS,
  TILE_SOURCE: TILE_SOURCE,
  TILE_TIMEOUT_MS: TILE_TIMEOUT_MS,
  TILE_RETRY_MS: TILE_RETRY_MS,
  FETCH_RADIUS_MI: FETCH_RADIUS_MI,
  TIER_TIMEOUT_MS: TIER_TIMEOUT_MS,
  createStore: createStore,
  addElements: addElements,
  wayCount: wayCount,
  tierOf: tierOf,
  tierQuery: tierQuery,
  statusOfError: statusOfError,
  createFetcher: createFetcher,
  pack: pack,
  unpack: unpack
};
