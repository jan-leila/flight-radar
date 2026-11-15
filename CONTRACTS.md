# Plane Watch — module contracts

Each part is built and tested on its own against the contract below. **Contract tests in `test/` are
the spec**: when this document and a test disagree, the test wins (and this doc gets fixed).

Two contracts come from outside: the watch draws what the original Flight Radar 0.4.1 draws for the same
messages (`tools/screenshots.sh`, baseline recorded from the original's binaries), and the phone sends what the
original sends for the same data (`test/parity.test.js`, reference recorded from the original's code). Anything
that changes a pixel or a byte fails one of them.

Conventions everywhere:

- **Time** is epoch **milliseconds** in JS. `now` is injected (`deps.now()`), never read from `Date` inside `src/common/`.
- **Positions** are degrees. **Distances** are statute miles (the zoom levels are miles). **Screen offsets** are pixels from the centre of the screen, x right, y down.
- `src/common/**` and `src/pkjs/**` are **ES5** (`var`, `function`, no arrow functions, no `let`/`const`, no template strings, no classes, no Promises). They run inside PebbleKit JS on the phone. Tests (`test/**`) and tools (`tools/**`) can use modern Node (v24).
- Async results use node-style callbacks: `cb(err, value)`.
- Modules use `require('./x')` / `module.exports`. No npm dependencies.
- The watch modules with logic in them (`radar_model`, `radar_label`) do not include `pebble.h`; they are compiled and tested on the host.

```
              ┌───────────────────────── phone (PebbleKit JS) ─────────────────────────┐
 adsb.lol ───►│ pkjs/index.js  (composition root: XMLHttpRequest, geolocation,        │
 Overpass ───►│   │             localStorage, AppMessage; the only file that knows them)│
              │   └─ session ──► roads (queries, fail-over, store, packed form) ─► geo │
              │         ├──────► planes (adsb.lol, nearest, trails)                    │
              │         ├──────► raster (roads -> bitmap, RLE) ──────────────────► geo │
              │         └──────► protocol (message bytes, send queue) ──► AppMessage ──┼──┐
              └───────────────────────────────────────────────────────────────────────┘  │
 watch (C): main.c (window, drawing, buttons, timers) ◄─ radar_model (messages, bitmap, selection) ◄─┘
                                                      ◄─ radar_label (where a label goes)
```

Modularity rules (`test/modularity.test.js`): `geo` and `planes` require nothing; `roads` and `raster` only `geo`;
`protocol` only `planes`; `session` is the only module in `src/common/` that knows the others and it touches the
phone only through its `deps`. `src/pkjs/index.js` requires `protocol` and `session` and nothing else.

---

## 1. `src/common/geo.js`

```js
geohash(lat, lon, precision)             // → string
milesBetween(lat1, lon1, lat2, lon2)     // → great-circle miles
projector(lat0, lon0, visibleMi, radiusPx) // → function (lat, lon) → [dx, dy] whole pixels from the centre
bbox(lat, lon, mi)                       // → [south, west, north, east]
```

`projector` is equirectangular: 69 miles per degree of latitude, `69 * cos(lat0)` per degree of longitude,
`radiusPx / visibleMi` pixels per mile, rounded with `Math.round`. `radiusPx` is half the shorter side of the
screen. The map and the aircraft go through the same projector, and its arithmetic is part of the reference
contract. See `test/geo.test.js`.

## 2. `src/common/protocol.js` — messages

AppMessage keys: `PAYLOAD` (10000, byte array), `CMD` (10001, int), `VAL` (10002, int).

**Phone → watch**: one `PAYLOAD` per message; byte 0 is the type. Integers are little-endian.

| type | name | body |
|---|---|---|
| `0x01` | `PAY_BEGIN` | lat, lon `i32` (1e-6 deg), visible miles `u16`, road status `u16`, plane count `u16`, geohash `char[5]`. Starts a full view. |
| `0x07` | `PAY_BITMAP_BEGIN` | `u32` size of the run-length encoded bitmap |
| `0x08` | `PAY_BITMAP_CHUNK` | the next bytes of it (a message is at most `CHUNK_BYTES` = 1024 bytes) |
| `0x03` | `PAY_PLANES` | count `u8`, then per plane a 36-byte record and `trail_n` × (`i16` x, `i16` y) |
| `0x06` | `PAY_END` | none. The view (or refresh) is complete. |
| `0x04` | `PAY_STATUS` | text, at most 60 characters |
| `0x05` | `PAY_ERROR` | text, at most 60 characters |
| `0x09` | `PAY_TRAIL` | hex `u8[3]`, count `u8`, count × (`i16` x, `i16` y): the flight path of one plane, oldest first |

The plane record (`RadarPlane` in `src/c/radar_model.h`): hex `u8[3]`, x `i16`, y `i16`, altitude band `u8`
(0 up to 12,000 ft, 1 up to 28,000 ft, 2 above), heading `u8` (256 steps per turn), callsign `char[8]`, tail
`char[8]`, type `char[6]` (upper case, NUL-padded), altitude `i16` (hundreds of feet), ground speed `u16` (knots),
`trail_n` `u8`.

A full view is `PAY_BEGIN`, `PAY_BITMAP_BEGIN`, chunks, `PAY_PLANES`, `PAY_END`. A refresh is `PAY_PLANES`,
`PAY_END`. Road status is a `roads.STATUS` value: 0 fine, 1 cached, 2 no roads in the region, 3 cooldown,
4 timeout, 5 HTTP error, 6 no network, 7 unparseable.

**Watch → phone**

| message | meaning |
|---|---|
| `CMD` 1, `VAL` = visible miles \| width << 12 \| height << 22 | `CMD_HELLO`: the app opened; sent every 2 s until the phone sends anything |
| `CMD` 2 | `CMD_REFRESH_PLANES`: every 30 s |
| `CMD` 3, `VAL` = visible miles | `CMD_REFRESH_ALL`: fetch the roads anew (the watch never sends it) |
| `CMD` 4, `VAL` = visible miles | `CMD_VIEW`: SELECT changed the zoom |
| `PAYLOAD` = `0x80`, hex `u8[3]` | `SUBCMD_SELECT`: a plane was selected, 300 ms ago |

```js
encodeBegin(lat, lon, visibleMi, roadStatus, planeCount, geohash) // → bytes
encodeBitmap(rle)                    // → [PAY_BITMAP_BEGIN, chunk, chunk, ...]
encodePlanes(list, project, selectedHex, selectedTrail) // → bytes. Planes beyond 200 px are left out, at most 48
                                     //   are sent; only the selected plane carries a trail (points beyond 1000 px dropped)
encodeTrail(hex, points, project)    // → bytes
encodeStatus(text), encodeError(text), encodeEnd()
decodeWatchMessage(payload)          // → {type: 'hello', visibleMi, width, height} | {type: 'refreshPlanes'}
                                     //   | {type: 'refreshAll', visibleMi} | {type: 'view', visibleMi}
                                     //   | {type: 'select', hex} | null
createSender({send, setTimeout, log?}) // → {send(bytes), pending()}
```

`createSender` delivers one message at a time, in order. A message that is not acknowledged is sent again twice,
500 ms apart, and then dropped. See `test/protocol.test.js`.

## 3. `src/common/roads.js` — Overpass and the road store

```js
TIERS = ['motorway', 'trunk', 'primary', 'secondary']   // `<tier>_link` roads belong to their tier
STATUS = {OK, CACHE, EMPTY_REGION, COOLDOWN, TIMEOUT, HTTP, NETWORK, PARSE}   // 0..7
ENDPOINTS                             // Overpass interpreters, tried in this order
createStore()                         // → {tiers: {<tier>: {lat: [], lon: [], ends: []}}}; ends[i]: one past way i's last point
addElements(store, tier, elements)    // appends the ways of an Overpass `elements` array; → ways added
wayCount(store)
tierQuery(tier, lat, lon)             // → Overpass QL: the tier's ways within 40 miles, `out ids geom`
statusOfError(err)                    // → STATUS for the watch's banner
createFetcher({http, now, endpoints?}) // → {fetchTier(tier, lat, lon, cb(err, elements))}
pack(store)                           // → {<tier>: base64} | null
unpack(packed)                        // → store; throws on malformed input
```

`fetchTier` posts the query to the endpoint that answered last (the first one at the start) and moves on to the
next on any failure: transport error, HTTP status, or a body without an `elements` array. An endpoint that
answers 429 is skipped for `Retry-After` seconds (300 without the header, 1800 at most). When every endpoint
failed, `cb` gets the last error; when all were skipped, an error with `cooldown: true`.

`pack` is lossless: a tier is the varint way count, then per way the varint point count and zigzag varint deltas
in 1e-7 degrees. OSM coordinates have seven decimals, so `unpack(pack(store))` holds the same doubles and a map
drawn from storage has the same pixels. `pack` returns `null` rather than round a coordinate with more decimals.
See `test/roads.test.js`.

## 4. `src/common/raster.js` — the map bitmap

```js
createRaster(width, height)   // → {width, height, render(store, lat0, lon0, visibleMi, radiusPx) → Uint8Array}
rleEncode(buffer)             // → [colour, count, colour, count, ...], count 1..255
COLOR_BACKGROUND = 0xC0, COLOR_ROAD = 0xD5, COLOR_YOU = 0xFC   // GColor8
```

`render` returns one GColor8 byte per pixel, row by row, in a buffer the next call overwrites. Tiers are drawn
secondary, primary, trunk, motorway. A way is a Bresenham polyline through its projected points, both ends of
every segment included. Motorways and trunk roads are two pixels wide (the second pixel is below a mostly
horizontal segment, right of a mostly vertical one); primary and secondary roads are one pixel wide and plotted
only where `x + y` is even. Last comes the position: a disc of radius 3 at `(width >> 1, height >> 1)`.
See `test/raster.test.js`.

## 5. `src/common/planes.js` — aircraft and flight paths

```js
planesUrl(lat, lon, radiusMi), traceUrl(hex)
parsePlanes(response)        // adsb.lol /v2 → [{hex, lat, lon, alt, gs, track, callsign, tail, type}]
nearest(planes, lat0, lon0, max) // → the `max` closest, closest first
parseTrace(response)         // readsb trace_recent → [{lat, lon, ts}]; throws on a malformed file
decimate(points, max)        // → at most max points: both ends and evenly spaced ones between
createTrails(now)            // → {observe(planes), mergeTrace(hex, points), wirePoints(hex), claimTrace(hex)}
```

`parsePlanes` drops aircraft without a position or with an address that is not six hex digits (or all zeros),
takes `alt_baro`, else `alt_geom`, else 0 (`"ground"` is not a number), and empties callsigns that are one
repeated character. A trail gets a point per `observe` in which the plane moved (by 1e-5 degrees), keeps 80
points and half an hour; `wirePoints` thins it to 16. `mergeTrace` merges a recorded trace by time, drops
repeated places and keeps the newest 16 points of the last half hour. `claimTrace` is true once per plane.
See `test/planes.test.js`.

## 6. `src/common/session.js` — the phone side

```js
createSession(deps) // → {handle(message)}       message: a protocol.decodeWatchMessage() result
deps = {
  http(req, cb(err, text)),   // req: {method, url, body?, timeout}; err.message 'timeout' | 'network' | 'HTTP <status>',
                              //      err.status, err.retryAfter (seconds)
  locate(cb(err, lat, lon)),
  storage: {get(key) → string | null, set(key, string)},   // set may throw
  now() → ms, setTimeout(fn, ms),
  send(bytes),                // queue one PAYLOAD
  backlog() → number,         // messages queued but not delivered
  log(text),
  endpoints?                  // Overpass endpoints, for tests
}
```

- **hello** sets the screen size and zoom, then locates (`Locating...`). A failure goes to the watch as
  `PAY_ERROR`. With the position: the stored map is reused when it has the same 5-character geohash, is less
  than a mile away and less than a week old (`Cache hit, planes...`); otherwise a new map is started for the
  position and its roads are fetched (`Fetching planes...`). The aircraft are fetched either way and a full view
  is sent as soon as they are there, with whatever roads have arrived.
- **Roads** load one tier after the other, motorway first, one fetch at a time. The map is sent again when the
  trunk roads are in and when all tiers are in, each time only once the watch has taken the previous messages
  (`backlog() == 0`, checked every second). While they load, every `PAY_END` is followed by
  `PAY_STATUS "Fetching roads..."` (the watch hides its status line at `PAY_END`), and the road status is OK.
  A complete map is stored (`roads_v1`, at most 3,000,000 characters).
- **A failed tier** ends the fetch: the map goes out with the tiers that arrived and the error's status. A later
  `refreshPlanes`, at least two minutes after the attempt started, resumes with the missing tiers. If nothing
  arrived for a new place and an older complete map exists, that map is shown instead, centred where it was
  fetched, with status `CACHE`.
- **refreshPlanes** fetches the aircraft at the map's centre, at most every 20 s (so every 30 s refresh of the watch is answered), and sends `PAY_PLANES`,
  `PAY_END` (a full view when the roads changed since the last one, or none was sent yet). Without a map it
  acts like hello.
- **view** sets the zoom and sends a full view from the roads in memory; without a map it acts like hello.
- **refreshAll** is hello with the stored map ignored.
- **select** sends the plane's trail at once (`PAY_TRAIL`), and again after fetching its recorded trace, once
  per plane. From then on `PAY_PLANES` carries the trail of the selected plane.

The map is always centred on the position its roads were fetched for, as in the original. See
`test/session.test.js`, `test/parity.test.js`.

## 7. `src/c/radar_model.{h,c}` — watch state

```c
void radar_model_init(RadarModel *m);                                   // status "Starting...", nothing selected
unsigned radar_model_set_screen(RadarModel *m, int16_t w, int16_t h);   // allocates the w*h map
unsigned radar_model_receive(RadarModel *m, const uint8_t *data, uint16_t length);
unsigned radar_model_dropped(RadarModel *m, int reason);
RadarStep radar_model_step(RadarModel *m, int dir, bool round);         // RADAR_STEP_NONE | _SELECTED | _NO_TRAFFIC
void radar_model_deselect(RadarModel *m);
void radar_format_altitude(int16_t alt100, char *out, size_t size);     // "GND", "900 ft", "12,300 ft"
```

The `unsigned` results are actions for the caller, a bit set of `RADAR_REDRAW`, `RADAR_STATUS` (show
`m->status`, or hide the line when it is empty), `RADAR_STOP_STATUS_TIMER` and `RADAR_LOG`.

- `PAY_BEGIN` clears a watch error, stores the road status, empties the plane list and shows `Receiving...`.
- `PAY_STATUS` / `PAY_ERROR` put their text on the status line (63 characters at most; empty hides it).
- `PAY_BITMAP_BEGIN` allocates the announced size (1 .. `(w*h + 512) * 2`); chunks are appended.
- `PAY_END` decodes what arrived into the map (pairs past the end are cut, pixels not covered are background),
  marks the view complete, and sets the status line: empty when the road status is 0, else the status's text
  (`[PE1] cached roads` … `[PE8] UA blocked`, `[PE?] unknown`), again after every refresh.
- `PAY_PLANES` replaces the list: at most 32 planes, 16 trail points each; a record or trail cut short ends the
  list. A selection follows its plane's address to the new index, or to none while the plane is missing.
- `PAY_TRAIL` replaces one plane's trail and moves the plane to the trail's last point.
- Watch errors (`[WE1] pixels OOM WxH` / `no pixbuf`, `[WE2] BEGIN short n`, `[WE3] BMBEG short n` /
  `RLE bad sz n`, `[WE4] RLE OOM n`, `[WE5] chunk w/o BEGIN` / `ovf a+b>c`, `[WE6] drop r @a/b`,
  `[WE7] no bitmap recvd`, `[WE8] trunc a/b`) go on the status line and stay until the next `PAY_BEGIN`.
- `radar_model_step` orders the planes on screen (rectangular: within half the width / height plus 8 px;
  round: within the radius plus 8 px) by distance from the centre, list order breaking ties, and moves the
  selection one step, wrapping. With nothing selected, 1 picks the closest and -1 the farthest. With planes but
  none on screen: `No traffic in view` on the status line. With no planes: nothing.

See `test/c/test_radar_model.c`.

## 8. `src/c/radar_label.{h,c}` — label placement

```c
RadarPoint radar_label_place(RadarPoint anchor, int w, int h, RadarScreen screen,
                             RadarPoint origin, const RadarPoint *trail, int trail_n);
bool radar_label_segment_hits(RadarPoint a, RadarPoint b, RadarBox box);
bool radar_label_fits_round(RadarBox box, int screen_w, int screen_h);
```

`radar_label_place` returns the top-left corner of a `w` × `h` box for the aircraft at `anchor`: the first of
twelve candidates — right of the aircraft (+10, −8), (+10, +6); left of it (−10, −8), (−10, +6); centred above
(−28) and below (+16); then (±30, ±20) and centred at −50 and +40 — that starts at x, y ≥ 2, ends before the
last column and row, fits inside the circle on a round screen (all corners within the radius minus 2), and is
not crossed by the flight path (`trail` plus the leg to the aircraft; a segment crosses when one of its ends or
of the points about 5 px apart along it is in the box). Otherwise the box goes to (+10, −8), is pushed back on
screen, and on a round screen walks towards the centre in 4 px steps (at most 30) until it fits.
See `test/c/test_radar_label.c`.

## 9. `src/c/main.c` — the watch app

Not unit-tested; covered by `tools/screenshots.sh` against the original, scene by scene.

- The map layer copies `m->pixels` into the frame buffer once a view is complete (black before), then draws the
  planes in list order and the selected one last.
- A plane is a 4-point arrowhead ((0,−7), (6,6), (0,3), (−6,6)) rotated to its heading and filled orange, red or
  blue by altitude band; selected: green with a white outline, after its trail (green, 2 px wide).
- Unselected planes get a one-line label (callsign in white, or the address in light grey) unless a labelled
  plane earlier in the list is within 24 px, or the plane is within 20 px of the left or right edge, 15 px of the
  top or 14 px of the bottom. The selected plane gets four lines: callsign (or address, orange), type and tail
  (`no type` / `no tail`, orange when either is missing), altitude, speed. Font: Gothic 14 Bold; the box is
  black, 3 px wider than the text on each side, corner radius 2.
- The status line (Gothic 18, white on black, centred) is 200 × 28 in the middle of the screen until the first
  view is complete, then 26 px high at three quarters of the height, inset 30 px on each side.
- Timers: hello after 250 ms and every 2 s until the phone answers; refresh every 30 s; `SUBCMD_SELECT` 300 ms
  after the last UP / DOWN; `No traffic in view` is hidden after 1.8 s.
- SELECT cycles 5, 10, 20, 40 miles (starting at 20), shows `<n>mi (rendering...)` and sends `CMD_VIEW`.

## 10. Test entries (`src/pkjs/ui-fixture.js`, `src/pkjs/app-fixture.js`)

Built instead of `index.js` with `PKJS_ENTRY=<file> pebble build`.

- `ui-fixture.js` (for `tools/screenshots.sh`): answers no hello; every `CMD_VIEW` runs the next entry of its
  `STEPS` and logs `UI-FIXTURE step N`, then `UI-FIXTURE done N` once the watch acknowledged everything; a
  `SUBCMD_SELECT` is logged as `UI-FIXTURE select <hex>`, answered with that plane's trail if it has one, and
  followed by `UI-FIXTURE trail <hex>`. The scene list in `tools/screenshots.sh` and `STEPS` go together.
- `app-fixture.js` (for `tools/test-app-emulator.sh`): replaces `XMLHttpRequest` and the position with canned
  ones, logs what was requested so far as `APP-FIXTURE seen planes=N roads=<tiers> trace=N unknown=N` every two seconds, and loads `index.js`.
