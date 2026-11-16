// The phone side of the app: answers the watch's commands with map and aircraft messages (CONTRACTS.md §6). ES5.
//
// Everything outside this module is injected, so the whole flow runs in tests without a phone:
//   deps.http(req, cb(err, body))     req: {method, url, body, timeout, binary}; err.message 'timeout' | 'network' | 'HTTP n'
//   deps.locate(cb(err, lat, lon))
//   deps.storage                      {get(key) -> string | null, set(key, string)}; set may throw
//   deps.now() -> ms, deps.setTimeout(fn, ms)
//   deps.send(bytes)                  queues one PAYLOAD for the watch (protocol.createSender)
//   deps.backlog() -> number          messages queued but not yet delivered
//   deps.log(text)
//
// Aircraft never wait for roads: the first view goes out as soon as the aircraft are known, and the map is sent
// again as the road tiers arrive. Roads are fetched once per place and kept for a week.

var geo = require('./geo');
var roads = require('./roads');
var raster = require('./raster');
var planes = require('./planes');
var protocol = require('./protocol');

var STORAGE_KEY = 'roads_v1';
var STORAGE_VERSION = 1;
var MAX_STORED_CHARS = 3000000;          // localStorage holds about five million characters per app
var ROADS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var SAME_PLACE_MI = 1;                   // closer than this to the stored map's centre: reuse it as it is
// The watch asks every 30 s, and an answer takes a moment: a floor of 30 s would drop every other request.
var PLANES_MIN_MS = 20 * 1000;
var PLANES_TIMEOUT_MS = 12000;
var TRACE_TIMEOUT_MS = 8000;
var ROADS_RETRY_MS = 2 * 60 * 1000;      // after a failed road fetch, try again on a later refresh
var FLUSH_RETRY_MS = 1000;
var GEOHASH_LENGTH = 5;

function createSession(deps) {
  // Until the watch reports its screen (CMD_HELLO) assume the round 260 x 260 one.
  var view = { width: 260, height: 260, radiusPx: 130, visibleMi: 20 };
  var canvas = null;
  // The map being shown: {lat, lon, geohash, ts, store, status, pending: tiers still to fetch, loading,
  // attemptTs, dirty: roads changed since the last full view}. Its centre is where the roads were fetched for.
  var map = null;
  var fallback = null;                   // the previous complete map, shown if the new place's roads fail
  var lastPlanes = { ts: 0, list: [] };
  var trails = planes.createTrails(deps.now);
  var fetcher = roads.createFetcher({
    http: deps.http, now: deps.now, endpoints: deps.endpoints, tileSource: deps.tileSource, log: deps.log
  });
  var selectedHex = null;
  var locating = false;
  var flushScheduled = false;

  function status(text) { deps.send(protocol.encodeStatus(text)); }

  function fail(text) {
    deps.log('error: ' + text);
    deps.send(protocol.encodeError(text));
  }

  function project() { return geo.projector(map.lat, map.lon, view.visibleMi, view.radiusPx); }

  function complete(m) { return !m.pending.length; }

  // ---- messages -----------------------------------------------------------------------------------------------

  function sendPlanes(list) {
    deps.send(protocol.encodePlanes(list, project(), selectedHex, selectedHex ? trails.wirePoints(selectedHex) : []));
    deps.send(protocol.encodeEnd());
    // PAY_END hides the watch's status line, so the reminder has to follow every one of them.
    if (map.loading) status('Fetching roads...');
  }

  function shipView() {
    var list = planes.nearest(lastPlanes.list, map.lat, map.lon, planes.MAX_WIRE_PLANES);
    var messages, i;
    if (!canvas || canvas.width !== view.width || canvas.height !== view.height) {
      canvas = raster.createRaster(view.width, view.height);
    }
    deps.send(protocol.encodeBegin(map.lat, map.lon, view.visibleMi, map.status, list.length, map.geohash));
    messages = protocol.encodeBitmap(raster.rleEncode(canvas.render(map.store, map.lat, map.lon, view.visibleMi, view.radiusPx)));
    for (i = 0; i < messages.length; i++) deps.send(messages[i]);
    map.dirty = false;
    sendPlanes(list);
  }

  function shipPlanes() {
    sendPlanes(planes.nearest(lastPlanes.list, map.lat, map.lon, planes.MAX_WIRE_PLANES));
  }

  function shipTrail(hex) {
    if (!map) return;
    deps.send(protocol.encodeTrail(hex, trails.wirePoints(hex), project()));
  }

  // Sends the map again once the roads changed, the aircraft are known and the previous view is delivered.
  function flush() {
    flushScheduled = false;
    if (!map || !map.dirty || !lastPlanes.ts) return;
    if (deps.backlog() > 0) {
      flushScheduled = true;
      deps.setTimeout(flush, FLUSH_RETRY_MS);
      return;
    }
    shipView();
  }

  function roadsChanged() {
    map.dirty = true;
    if (!flushScheduled) flush();
  }

  // ---- roads --------------------------------------------------------------------------------------------------

  function persist(m) {
    var packed = roads.pack(m.store);
    var text;
    if (!packed) { deps.log('roads not stored: coordinates do not pack losslessly'); return; }
    text = JSON.stringify({ v: STORAGE_VERSION, lat: m.lat, lon: m.lon, geohash: m.geohash, ts: m.ts, status: m.status, roads: packed });
    if (text.length > MAX_STORED_CHARS) { deps.log('roads not stored: ' + text.length + ' characters'); return; }
    try {
      deps.storage.set(STORAGE_KEY, text);
    } catch (e) {
      deps.log('roads not stored: ' + e);
    }
  }

  function restore() {
    var saved;
    try {
      saved = JSON.parse(deps.storage.get(STORAGE_KEY) || 'null');
      if (!saved || saved.v !== STORAGE_VERSION || typeof saved.lat !== 'number' || typeof saved.lon !== 'number') return;
      map = {
        lat: saved.lat, lon: saved.lon, geohash: String(saved.geohash || ''), ts: Number(saved.ts) || 0,
        store: roads.unpack(saved.roads),
        status: saved.status === roads.STATUS.EMPTY_REGION ? roads.STATUS.EMPTY_REGION : roads.STATUS.OK,
        pending: [], loading: false, attemptTs: 0, dirty: true
      };
    } catch (e) {
      deps.log('stored roads ignored: ' + e);
      map = null;
    }
  }

  function loadRoads() {
    var job = map;
    if (job.loading || complete(job)) return;
    job.loading = true;
    job.status = roads.STATUS.OK;
    job.attemptTs = deps.now();

    function next() {
      var tier;
      if (job !== map) return;
      if (complete(job)) {
        job.loading = false;
        job.status = roads.wayCount(job.store) ? roads.STATUS.OK : roads.STATUS.EMPTY_REGION;
        job.ts = deps.now();
        fallback = null;
        persist(job);
        roadsChanged();
        return;
      }
      tier = job.pending[0];
      fetcher.fetchTier(tier, job.lat, job.lon, function (err, elements) {
        if (job !== map) return;
        if (err) {
          deps.log('roads (' + tier + '): ' + err.message);
          job.loading = false;
          if (fallback && job.pending.length === roads.TIERS.length) {
            // Nothing arrived for the new place: show the previous map, centred where it was fetched.
            map = fallback;
            map.status = roads.STATUS.CACHE;
            fallback = null;
          } else {
            job.status = roads.statusOfError(err);
          }
          roadsChanged();
          return;
        }
        roads.addElements(job.store, tier, elements);
        job.pending.shift();
        // The major roads are enough to recognise the area: show them while the minor ones load.
        if (tier === 'trunk') roadsChanged();
        next();
      });
    }

    next();
  }

  function startMap(lat, lon, geohash) {
    if (map && complete(map)) {
      fallback = map;
      fallback.status = roads.wayCount(fallback.store) ? roads.STATUS.OK : roads.STATUS.EMPTY_REGION;
    }
    map = {
      lat: lat, lon: lon, geohash: geohash, ts: deps.now(), store: roads.createStore(), status: roads.STATUS.OK,
      pending: roads.TIERS.slice(), loading: false, attemptTs: 0, dirty: true
    };
    loadRoads();
  }

  function reusable(lat, lon, geohash) {
    return !!map && map.geohash === geohash && deps.now() - map.ts < ROADS_TTL_MS &&
           geo.milesBetween(lat, lon, map.lat, map.lon) < SAME_PLACE_MI;
  }

  // ---- aircraft -----------------------------------------------------------------------------------------------

  function fetchPlanes(cb) {
    var url = planes.planesUrl(map.lat, map.lon, roads.FETCH_RADIUS_MI);
    deps.http({ method: 'GET', url: url, timeout: PLANES_TIMEOUT_MS }, function (err, text) {
      var list;
      if (!err) {
        try { list = planes.parsePlanes(JSON.parse(text)); } catch (e) { err = e; }
      }
      if (err) { cb(err); return; }
      lastPlanes = { ts: deps.now(), list: list };
      cb(null);
      // After the view went out: a path shows where the plane has been, not where it is.
      trails.observe(list);
    });
  }

  function fullFetch(bypassStored) {
    if (locating) return;
    locating = true;
    status('Locating...');
    deps.locate(function (err, lat, lon) {
      var geohash;
      locating = false;
      if (err) { fail(err.message); return; }
      geohash = geo.geohash(lat, lon, GEOHASH_LENGTH);
      if (!bypassStored && reusable(lat, lon, geohash)) {
        status(complete(map) ? 'Cache hit, planes...' : 'Fetching planes...');
        loadRoads();
      } else {
        startMap(lat, lon, geohash);
        status('Fetching planes...');
      }
      fetchPlanes(function (err2) {
        if (err2) { fail('planes: ' + err2.message); return; }
        shipView();
      });
    });
  }

  function refreshPlanes() {
    if (!map) { fullFetch(false); return; }
    if (!complete(map) && !map.loading && deps.now() - map.attemptTs >= ROADS_RETRY_MS) loadRoads();
    if (deps.now() - lastPlanes.ts < PLANES_MIN_MS) return;
    fetchPlanes(function (err) {
      if (err) { fail(err.message); return; }
      if (map.dirty) shipView(); else shipPlanes();
    });
  }

  function select(hex) {
    selectedHex = hex;
    shipTrail(hex);
    if (!trails.claimTrace(hex)) return;
    deps.http({ method: 'GET', url: planes.traceUrl(hex), timeout: TRACE_TIMEOUT_MS }, function (err, text) {
      var points;
      if (!err) {
        try { points = planes.parseTrace(JSON.parse(text)); } catch (e) { err = e; }
      }
      if (err) { deps.log('trace ' + hex + ': ' + err.message); return; }
      trails.mergeTrace(hex, points);
      shipTrail(hex);
    });
  }

  // `message` is a protocol.decodeWatchMessage() result.
  function handle(message) {
    if (!message) return;
    if (message.type === 'hello') {
      if (message.visibleMi > 0) view.visibleMi = message.visibleMi;
      if (message.width > 0 && message.height > 0) {
        view.width = message.width;
        view.height = message.height;
        view.radiusPx = Math.min(message.width, message.height) >> 1;
      }
      fullFetch(false);
    } else if (message.type === 'refreshAll') {
      if (message.visibleMi > 0) view.visibleMi = message.visibleMi;
      fullFetch(true);
    } else if (message.type === 'refreshPlanes') {
      refreshPlanes();
    } else if (message.type === 'view') {
      if (message.visibleMi > 0) view.visibleMi = message.visibleMi;
      if (map) shipView(); else fullFetch(false);
    } else if (message.type === 'select') {
      select(message.hex);
    }
  }

  restore();

  return { handle: handle };
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  ROADS_TTL_MS: ROADS_TTL_MS,
  PLANES_MIN_MS: PLANES_MIN_MS,
  ROADS_RETRY_MS: ROADS_RETRY_MS,
  createSession: createSession
};
