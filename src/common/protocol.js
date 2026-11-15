// Phone <-> watch messages (CONTRACTS.md §2). ES5. Mirrors src/c/radar_model.h: keep the two in step.
//
// Phone -> watch: every AppMessage carries one PAYLOAD byte array whose first byte is the message type.
// Watch -> phone: CMD + VAL integers, or a PAYLOAD byte array starting with SUBCMD_SELECT.

var planes = require('./planes');

var PAY_BEGIN = 0x01;
var PAY_PLANES = 0x03;
var PAY_STATUS = 0x04;
var PAY_ERROR = 0x05;
var PAY_END = 0x06;
var PAY_BITMAP_BEGIN = 0x07;
var PAY_BITMAP_CHUNK = 0x08;
var PAY_TRAIL = 0x09;

var SUBCMD_SELECT = 0x80;

var CMD_HELLO = 1;
var CMD_REFRESH_PLANES = 2;
var CMD_REFRESH_ALL = 3;
var CMD_VIEW = 4;

var CHUNK_BYTES = 1024;       // one AppMessage payload, type byte included
var MAX_TEXT = 60;
var PLANE_RANGE_PX = 200;     // planes further than this from the centre are not sent
var TRAIL_RANGE_PX = 1000;

var NACK_RETRIES = 2;
var NACK_RETRY_MS = 500;

function pushU16(out, v) { out.push(v & 0xff, (v >> 8) & 0xff); }
function pushI32(out, v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }

function pushAscii(out, text, length) {
  var s = String(text || '').toUpperCase();
  var i;
  for (i = 0; i < length; i++) out.push(i < s.length ? s.charCodeAt(i) & 0xff : 0);
}

function pushHex24(out, hex) {
  var s = String(hex || '');
  var i, v;
  for (i = 0; i < 3; i++) {
    v = parseInt(s.substr(i * 2, 2), 16);
    out.push(isNaN(v) ? 0 : v & 0xff);
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v | 0; }

function encodeText(type, text) {
  var s = String(text);
  var out = [type];
  var i;
  for (i = 0; i < s.length && i < MAX_TEXT; i++) out.push(s.charCodeAt(i) & 0xff);
  return out;
}

// Starts a full view. `roadStatus` is a roads.STATUS value; the watch shows a banner for anything but OK.
function encodeBegin(lat, lon, visibleMi, roadStatus, planeCount, geohash) {
  var out = [PAY_BEGIN];
  var i;
  pushI32(out, Math.round(lat * 1e6));
  pushI32(out, Math.round(lon * 1e6));
  pushU16(out, visibleMi);
  pushU16(out, roadStatus);
  pushU16(out, planeCount);
  for (i = 0; i < 5; i++) out.push(i < geohash.length ? geohash.charCodeAt(i) : 0);
  return out;
}

// The run-length encoded bitmap as messages: PAY_BITMAP_BEGIN with the byte count, then the chunks in order.
function encodeBitmap(rle) {
  var begin = [PAY_BITMAP_BEGIN];
  var out = [begin];
  var pos, end, chunk, i;
  pushI32(begin, rle.length);
  for (pos = 0; pos < rle.length; pos = end) {
    end = Math.min(pos + CHUNK_BYTES - 1, rle.length);
    chunk = [PAY_BITMAP_CHUNK];
    for (i = pos; i < end; i++) chunk.push(rle[i]);
    out.push(chunk);
  }
  return out;
}

function projectTrail(points, project) {
  var out = [];
  var i, p;
  for (i = 0; i < points.length; i++) {
    p = project(points[i].lat, points[i].lon);
    if (Math.abs(p[0]) > TRAIL_RANGE_PX || Math.abs(p[1]) > TRAIL_RANGE_PX) continue;
    out.push(p);
  }
  return out;
}

function pushTrail(out, trail) {
  var i;
  out.push(trail.length & 0xff);
  for (i = 0; i < trail.length; i++) {
    pushU16(out, trail[i][0]);
    pushU16(out, trail[i][1]);
  }
}

// PAY_PLANES: count, then per plane a 36-byte record followed by its trail points. Only the selected plane
// carries a trail (`selectedTrail`: its path as [{lat, lon}], oldest first). `list` should already be sorted and
// capped with planes.nearest(); planes outside PLANE_RANGE_PX are left out.
function encodePlanes(list, project, selectedHex, selectedTrail) {
  var out = [PAY_PLANES, 0];
  var count = 0;
  var i, p, at;
  for (i = 0; i < list.length && count < planes.MAX_WIRE_PLANES; i++) {
    p = list[i];
    at = project(p.lat, p.lon);
    if (Math.abs(at[0]) > PLANE_RANGE_PX || Math.abs(at[1]) > PLANE_RANGE_PX) continue;
    pushHex24(out, p.hex);
    pushU16(out, at[0]);
    pushU16(out, at[1]);
    out.push(p.alt > 28000 ? 2 : p.alt > 12000 ? 1 : 0);                 // altitude band, picks the colour
    out.push(((Math.round(p.track * 256 / 360) % 256) + 256) % 256);     // heading, 256 steps per turn
    pushAscii(out, p.callsign, 8);
    pushAscii(out, p.tail, 8);
    pushAscii(out, p.type, 6);
    pushU16(out, clamp(Math.round((p.alt || 0) / 100), -32768, 32767));  // hundreds of feet
    pushU16(out, clamp(Math.round(p.gs || 0), 0, 65535));                // knots
    pushTrail(out, p.hex === selectedHex ? projectTrail(selectedTrail || [], project) : []);
    count++;
  }
  out[1] = count;
  return out;
}

function encodeTrail(hex, points, project) {
  var out = [PAY_TRAIL];
  pushHex24(out, hex);
  pushTrail(out, projectTrail(points, project));
  return out;
}

function hexOfBytes(bytes) {
  var s = '';
  var i, b;
  for (i = 0; i < bytes.length; i++) {
    b = bytes[i] & 0xff;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

// AppMessage payload from the watch (keys by name) -> one of
//   {type: 'hello', visibleMi, width, height}   width/height 0 when the watch did not say
//   {type: 'refreshPlanes'}
//   {type: 'refreshAll', visibleMi}             visibleMi 0: keep the current zoom
//   {type: 'view', visibleMi}
//   {type: 'select', hex}
//   null for anything else.
function decodeWatchMessage(payload) {
  var p = payload || {};
  var val = typeof p.VAL === 'number' && p.VAL > 0 ? p.VAL : 0;
  if (p.PAYLOAD && p.PAYLOAD.length >= 4 && p.PAYLOAD[0] === SUBCMD_SELECT) {
    return { type: 'select', hex: hexOfBytes([p.PAYLOAD[1], p.PAYLOAD[2], p.PAYLOAD[3]]) };
  }
  if (p.CMD === CMD_HELLO) {
    // visibleMi in the low 12 bits, then the screen width and height, 10 bits each
    return { type: 'hello', visibleMi: val & 0xfff, width: (val >>> 12) & 0x3ff, height: (val >>> 22) & 0x3ff };
  }
  if (p.CMD === CMD_REFRESH_PLANES) return { type: 'refreshPlanes' };
  if (p.CMD === CMD_REFRESH_ALL) return { type: 'refreshAll', visibleMi: val };
  if (p.CMD === CMD_VIEW) return { type: 'view', visibleMi: val };
  return null;
}

// Sends messages one at a time, each after the previous one was acknowledged. A message that is not
// acknowledged is retried NACK_RETRIES times and then dropped, so one lost message cannot block the queue.
//   deps: { send(dict, onAck, onNack), setTimeout(fn, ms), log?(text) }
function createSender(deps) {
  var queue = [];
  var busy = false;
  var retries = 0;

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    deps.send({ PAYLOAD: queue[0] }, function () {
      queue.shift();
      retries = 0;
      busy = false;
      next();
    }, function () {
      if (deps.log) deps.log('message type ' + queue[0][0] + ' not acknowledged (retry ' + retries + ')');
      if (retries < NACK_RETRIES) {
        retries++;
        deps.setTimeout(function () { busy = false; next(); }, NACK_RETRY_MS);
        return;
      }
      queue.shift();
      retries = 0;
      busy = false;
      next();
    });
  }

  return {
    send: function (bytes) { queue.push(bytes); next(); },
    pending: function () { return queue.length; }
  };
}

module.exports = {
  PAY_BEGIN: PAY_BEGIN,
  PAY_PLANES: PAY_PLANES,
  PAY_STATUS: PAY_STATUS,
  PAY_ERROR: PAY_ERROR,
  PAY_END: PAY_END,
  PAY_BITMAP_BEGIN: PAY_BITMAP_BEGIN,
  PAY_BITMAP_CHUNK: PAY_BITMAP_CHUNK,
  PAY_TRAIL: PAY_TRAIL,
  SUBCMD_SELECT: SUBCMD_SELECT,
  CMD_HELLO: CMD_HELLO,
  CMD_REFRESH_PLANES: CMD_REFRESH_PLANES,
  CMD_REFRESH_ALL: CMD_REFRESH_ALL,
  CMD_VIEW: CMD_VIEW,
  CHUNK_BYTES: CHUNK_BYTES,
  encodeBegin: encodeBegin,
  encodeBitmap: encodeBitmap,
  encodePlanes: encodePlanes,
  encodeTrail: encodeTrail,
  encodeStatus: function (text) { return encodeText(PAY_STATUS, text); },
  encodeError: function (text) { return encodeText(PAY_ERROR, text); },
  encodeEnd: function () { return [PAY_END]; },
  decodeWatchMessage: decodeWatchMessage,
  createSender: createSender
};
