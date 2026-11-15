// Renders the road map the watch blits behind the planes (CONTRACTS.md §4). ES5.
//
// The bitmap is one GColor8 byte per pixel, the size of the watch's screen, with the phone's position in the
// middle. Every plotted pixel is part of the look of the app: the line stepping, the 2 px widening and the
// checkerboard used for minor roads are fixed by test/raster.test.js and by the recorded reference streams.

var geo = require('./geo');

var COLOR_BACKGROUND = 0xC0;  // GColorBlack
var COLOR_ROAD = 0xD5;        // GColorDarkGray
var COLOR_YOU = 0xFC;         // GColorYellow
var YOU_RADIUS = 3;

// Faintest first, so the major roads paint over the minor ones. Minor roads are drawn as a checkerboard, which
// reads as a darker grey than the darkest one the display has.
var LAYERS = [
  { tier: 'secondary', wide: false, dither: true },
  { tier: 'primary', wide: false, dither: true },
  { tier: 'trunk', wide: true, dither: false },
  { tier: 'motorway', wide: true, dither: false }
];

function createRaster(width, height) {
  var buf = new Uint8Array(width * height);

  function plot(x, y, dither) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    if (dither && ((x + y) & 1) !== 0) return;
    buf[y * width + x] = COLOR_ROAD;
  }

  // Bresenham from (x0, y0) to (x1, y1), both ends included. A wide line also plots the neighbour one pixel
  // further along the minor axis (below a mostly horizontal line, right of a mostly vertical one).
  function line(x0, y0, x1, y1, wide, dither) {
    var dx = Math.abs(x1 - x0);
    var dy = Math.abs(y1 - y0);
    var ox = wide && dx < dy ? 1 : 0;
    var oy = wide && dx >= dy ? 1 : 0;
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var e2;
    // Nothing of a segment that lies entirely off one side can be plotted.
    if ((x0 < -1 && x1 < -1) || (x0 >= width && x1 >= width) || (y0 < -1 && y1 < -1) || (y0 >= height && y1 >= height)) return;
    for (;;) {
      plot(x0, y0, dither);
      if (wide) plot(x0 + ox, y0 + oy, dither);
      if (x0 === x1 && y0 === y1) return;
      e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function disc(cx, cy, r, color) {
    var dy, y, span, x;
    for (dy = -r; dy <= r; dy++) {
      y = cy + dy;
      if (y < 0 || y >= height) continue;
      span = Math.floor(Math.sqrt(r * r - dy * dy));
      for (x = Math.max(0, cx - span); x <= Math.min(width - 1, cx + span); x++) buf[y * width + x] = color;
    }
  }

  // Draws `store` (roads.createStore) around (lat0, lon0) with `radiusPx` pixels spanning `visibleMi` miles,
  // then the position dot. Returns the raster's buffer, which the next render() overwrites.
  function render(store, lat0, lon0, visibleMi, radiusPx) {
    var project = geo.projector(lat0, lon0, visibleMi, radiusPx);
    var cx = width >> 1;
    var cy = height >> 1;
    var i, layer, t, w, k, start, p, px, py, qx, qy;
    for (i = 0; i < buf.length; i++) buf[i] = COLOR_BACKGROUND;
    for (i = 0; i < LAYERS.length; i++) {
      layer = LAYERS[i];
      t = store ? store.tiers[layer.tier] : null;
      start = 0;
      for (w = 0; t && w < t.ends.length; w++) {
        if (t.ends[w] - start >= 2) {
          p = project(t.lat[start], t.lon[start]);
          px = cx + p[0];
          py = cy + p[1];
          for (k = start + 1; k < t.ends[w]; k++) {
            p = project(t.lat[k], t.lon[k]);
            qx = cx + p[0];
            qy = cy + p[1];
            line(px, py, qx, qy, layer.wide, layer.dither);
            px = qx;
            py = qy;
          }
        }
        start = t.ends[w];
      }
    }
    disc(cx, cy, YOU_RADIUS, COLOR_YOU);
    return buf;
  }

  return { width: width, height: height, render: render, buffer: buf };
}

// Run-length encodes a bitmap as (colour, count) byte pairs, count 1..255.
function rleEncode(buf) {
  var out = [];
  var i = 0;
  var color, run;
  while (i < buf.length) {
    color = buf[i];
    run = 1;
    while (run < 255 && i + run < buf.length && buf[i + run] === color) run++;
    out.push(color, run);
    i += run;
  }
  return out;
}

module.exports = {
  COLOR_BACKGROUND: COLOR_BACKGROUND,
  COLOR_ROAD: COLOR_ROAD,
  COLOR_YOU: COLOR_YOU,
  createRaster: createRaster,
  rleEncode: rleEncode
};
