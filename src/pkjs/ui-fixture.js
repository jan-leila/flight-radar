// Alternative PebbleKit JS entry for testing the watch UI alone:
//   PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build
// Used by tools/screenshots.sh. ES5. No network, no clock: every message is built from the tables below, so a
// watch binary driven by this file always ends up showing the same pixels.
//
// The watch gives the cues. Its hello (CMD_HELLO) is logged and left unanswered, so the first screen stays up.
// Every SELECT press (CMD_VIEW) runs the next entry of STEPS and logs 'UI-FIXTURE step N', then
// 'UI-FIXTURE done N' once the watch acknowledged the step's last message. A selection (SUBCMD_SELECT) is
// answered with that plane's flight path when it has one, and logged as 'UI-FIXTURE select <hex>' followed by
// 'UI-FIXTURE trail <hex>' once the answer is delivered.
// tools/screenshots.sh walks the steps in order: keep the two in sync.

var protocol = require('../common/protocol');
var raster = require('../common/raster');
var roads = require('../common/roads');
var town = require('./fixture-town');

var CENTER = town.CENTER;
var VISIBLE_MI = 20;

var screen = { width: 200, height: 228 };
var step = 0;
var planesShown = [];

var sender = protocol.createSender({
  send: function (dict, onAck, onNack) { Pebble.sendAppMessage(dict, onAck, onNack); },
  setTimeout: function (fn, ms) { setTimeout(fn, ms); },
  log: function (text) { console.log('UI-FIXTURE ' + text); }
});

function whenDelivered(text) {
  var timer = setInterval(function () {
    if (sender.pending()) return;
    clearInterval(timer);
    console.log(text);
  }, 100);
}

// ---- roads ---------------------------------------------------------------------------------------------------

function townRoads() {
  var store = roads.createStore();
  var i;
  for (i = 0; i < roads.TIERS.length; i++) roads.addElements(store, roads.TIERS[i], town.elements(roads.TIERS[i]));
  return store;
}

// ---- planes --------------------------------------------------------------------------------------------------
// Positions are fractions of half the screen (x right, y down), so every scene covers the same parts of the
// rectangular and the round screen. `trail` is the flight path, oldest point first, in the same units.

function px(fx, fy) {
  return { x: Math.round(fx * screen.width / 2), y: Math.round(fy * screen.height / 2) };
}

// encodePlanes() and encodeTrail() project (lat, lon); the fixture works in pixels and hands them through.
function at(point) { return { lat: point.y, lon: point.x }; }
function identity(lat, lon) { return [lon, lat]; }

function plane(hex, fx, fy, fields) {
  var p = px(fx, fy);
  return {
    hex: hex, lat: p.y, lon: p.x,
    alt: fields.alt, gs: fields.gs || 0, track: fields.track || 0,
    callsign: fields.callsign || '', tail: fields.tail || '', type: fields.type || '',
    trail: fields.trail || null
  };
}

function byDistance(list) {
  return list.slice().sort(function (a, b) { return (a.lat * a.lat + a.lon * a.lon) - (b.lat * b.lat + b.lon * b.lon); });
}

// A busy sky: every altitude band, a plane without a callsign, a pair too close for two labels, planes at the
// edges and one just off screen.
function busySky() {
  return byDistance([
    plane('ac9abc', 0.12, -0.14, { alt: 825, gs: 146, track: 300, callsign: 'DAL2349', tail: 'N911DQ', type: 'B739',
      trail: [[0.62, 0.30], [0.50, 0.16], [0.40, 0.06], [0.30, -0.02], [0.22, -0.08], [0.12, -0.14]] }),
    plane('a057c7', 0.22, -0.10, { alt: 1675, gs: 131, track: 40, tail: 'N121DU', type: 'BCS1' }),
    plane('ab8ca5', 0.30, 0.22, { alt: 0, gs: 18, track: 180, callsign: 'SCX9200' }),
    plane('aa7f09', -0.46, 0.30, { alt: 15000, gs: 291, track: 90, callsign: 'UAL1144', tail: 'N77579', type: 'B39M' }),
    plane('a65e8c', -0.30, -0.56, { alt: 2800, gs: 87, track: 149, callsign: 'N5096C', tail: 'N5096C', type: 'C172' }),
    plane('ac486a', 0.52, 0.50, { alt: 35000, gs: 452, track: 200, callsign: 'SWA1687', tail: 'N8905Q', type: 'B38M' }),
    plane('a12263', 0.02, 0.80, { alt: 1725, gs: 109, track: 270, callsign: 'N172UF', tail: 'N172UF', type: 'C172' }),
    plane('ad3d84', -0.62, -0.62, { alt: 41000, gs: 475, track: 315, callsign: 'EJA952', tail: 'N952QS', type: 'C68A' }),
    plane('c031c9', 0.92, 0.08, { alt: 16675, gs: 269, track: 20, callsign: 'WEN3817', tail: 'C-FSWE', type: 'DH8D' }),
    plane('a471ec', -0.90, 0.04, { alt: 2950, gs: 172, track: 110, callsign: 'DAL2877', tail: 'N386DN', type: 'A321' }),
    plane('a76fc2', 1.10, -0.30, { alt: 1650, gs: 120, track: 250, callsign: 'N5789P' })
  ]);
}

// Planes in the corners, where a label has no room at its usual place, and paths that run through it.
function cornerSky() {
  return byDistance([
    plane('a0a30e', 0.34, -0.30, { alt: 12300, gs: 305, track: 225, callsign: 'DAL2446', tail: 'N140DU', type: 'BCS1',
      trail: [[0.90, -0.34], [0.74, -0.38], [0.60, -0.36], [0.48, -0.26], [0.40, -0.22], [0.34, -0.30]] }),
    plane('a34ae6', 0.66, -0.74, { alt: 900, gs: 96, track: 60, callsign: 'N311DU', type: 'P28A' }),
    plane('a066a3', -0.70, 0.72, { alt: 5400, gs: 180, track: 135, callsign: 'DAL2679', tail: 'N125DU', type: 'BCS1',
      trail: [[-0.20, 0.20], [-0.34, 0.34], [-0.48, 0.50], [-0.60, 0.62], [-0.70, 0.72]] }),
    plane('a36130', 0.74, 0.70, { alt: 29000, gs: 440, track: 0, callsign: 'DAL2673', tail: 'N317DU', type: 'BCS3' }),
    plane('a0b1ea', -0.72, -0.70, { alt: 0, gs: 0, track: 90 })
  ]);
}

// ---- messages ------------------------------------------------------------------------------------------------

function sendBegin(roadStatus, planeCount) {
  sender.send(protocol.encodeBegin(CENTER.lat, CENTER.lon, VISIBLE_MI, roadStatus, planeCount, '9zvxv'));
}

function sendPlanes(list) {
  planesShown = list;
  sender.send(protocol.encodePlanes(list, identity, null, []));
  sender.send(protocol.encodeEnd());
}

function sendView(store, roadStatus, list) {
  var canvas = raster.createRaster(screen.width, screen.height);
  var radius = Math.min(screen.width, screen.height) >> 1;
  var messages = protocol.encodeBitmap(raster.rleEncode(canvas.render(store, CENTER.lat, CENTER.lon, VISIBLE_MI, radius)));
  var i;
  sendBegin(roadStatus, list.length);
  for (i = 0; i < messages.length; i++) sender.send(messages[i]);
  sendPlanes(list);
}

var STEPS = [
  function () { sender.send(protocol.encodeStatus('Fetching roads...')); },
  function () { sendBegin(roads.STATUS.OK, 0); },
  function () { sendView(townRoads(), roads.STATUS.OK, busySky()); },
  function () { /* nothing: the watch keeps its own "rendering" note up */ },
  function () { sendPlanes(cornerSky()); },                                   // a refresh: same map, other planes
  function () { sendView(roads.createStore(), roads.STATUS.TIMEOUT, cornerSky()); },
  function () { sender.send(protocol.encodeError('GPS err 1')); },
  function () { sender.send([protocol.PAY_BITMAP_CHUNK, 1, 2, 3]); },          // a chunk without a bitmap
  function () { sendView(townRoads(), roads.STATUS.EMPTY_REGION, []); },
  function () { sendView(townRoads(), roads.STATUS.OK, busySky().slice(0, 3)); }
];

Pebble.addEventListener('ready', function () {
  console.log('UI-FIXTURE ready');
});

Pebble.addEventListener('appmessage', function (e) {
  var message = protocol.decodeWatchMessage(e.payload);
  var i, n, selected;
  if (!message) return;
  if (message.type === 'hello') {
    if (message.width > 0 && message.height > 0) screen = { width: message.width, height: message.height };
    console.log('UI-FIXTURE hello ' + screen.width + 'x' + screen.height);
  } else if (message.type === 'view') {
    n = ++step;
    console.log('UI-FIXTURE step ' + n + ' (' + message.visibleMi + ' mi)');
    if (STEPS[n - 1]) STEPS[n - 1]();
    whenDelivered('UI-FIXTURE done ' + n);
  } else if (message.type === 'select') {
    console.log('UI-FIXTURE select ' + message.hex);
    selected = null;
    for (i = 0; i < planesShown.length; i++) if (planesShown[i].hex === message.hex) selected = planesShown[i];
    if (selected && selected.trail) {
      sender.send(protocol.encodeTrail(message.hex, selected.trail.map(function (f) { return at(px(f[0], f[1])); }), identity));
    }
    whenDelivered('UI-FIXTURE trail ' + message.hex);
  }
});
