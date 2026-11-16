// Roads from vector map tiles (CONTRACTS.md §3a): which tiles cover a box, and the road lines in one tile. ES5.
//
// The tiles are Mapbox Vector Tiles in the OpenMapTiles schema: the layer "transportation" holds the roads, each
// with a "class" (motorway, trunk, primary, secondary, ...; ramps carry the class of their road). They come from a
// CDN, so they answer when the Overpass servers are busy; their geometry is simplified for the tile's zoom level.

// All four tiers are in the tiles from this zoom level on; a tile is about 35 miles wide at 45 degrees north.
var ZOOM = 9;
var LAYER = 'transportation';
var CLASS_KEY = 'class';
var DEFAULT_EXTENT = 4096;
// OSM coordinates have seven decimals; the stored form of the roads (roads.pack) needs that of these too.
var UNITS_PER_DEG = 1e7;

function tileX(lon, z) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, z));
}

function tileY(lat, z) {
  var n = Math.pow(2, z);
  var r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  var y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return Math.max(0, Math.min(n - 1, y));
}

// The tiles covering a box [south, west, north, east]: [{z, x, y}], x not wrapped (a box across the antimeridian
// has x below 0 or beyond the last column; url() wraps it, decode() keeps the longitudes continuous).
function cover(box, z) {
  var out = [];
  var x, y;
  z = z === undefined ? ZOOM : z;
  for (y = tileY(box[2], z); y <= tileY(box[0], z); y++) {
    for (x = tileX(box[1], z); x <= tileX(box[3], z); x++) out.push({ z: z, x: x, y: y });
  }
  return out;
}

// template: a TileJSON `tiles` entry ("https://host/path/{z}/{x}/{y}.pbf")
function url(template, tile) {
  var n = Math.pow(2, tile.z);
  return template.replace('{z}', tile.z).replace('{x}', ((tile.x % n) + n) % n).replace('{y}', tile.y);
}

// ---- protocol buffers -----------------------------------------------------------------------------------------

function reader(bytes, pos, end) {
  var r = { pos: pos || 0, end: end === undefined ? bytes.length : end };

  r.varint = function () {
    var v = 0;
    var scale = 1;
    var b;
    do {
      if (r.pos >= r.end) throw new Error('truncated tile');
      b = bytes[r.pos++];
      v += (b & 127) * scale;
      scale *= 128;
    } while (b >= 128);
    return v;
  };

  // Calls field(number, wireType) for every field; `field` reads the value or returns false to have it skipped.
  r.fields = function (field) {
    var key, type, len;
    while (r.pos < r.end) {
      key = r.varint();
      type = key % 8;
      if (field(Math.floor(key / 8), type) !== false) continue;
      if (type === 0) r.varint();
      else if (type === 1) r.pos += 8;
      else if (type === 2) { len = r.varint(); r.pos += len; }
      else if (type === 5) r.pos += 4;
      else throw new Error('bad tile');
    }
    if (r.pos > r.end) throw new Error('truncated tile');
  };

  // A length-delimited field as a reader of its own.
  r.sub = function () {
    var len = r.varint();
    var s = reader(bytes, r.pos, r.pos + len);
    if (s.end > r.end) throw new Error('truncated tile');
    r.pos = s.end;
    return s;
  };

  r.string = function () {
    var s = r.sub();
    var out = '';
    var i;
    // Road classes are ASCII; anything else only has to differ from them.
    for (i = s.pos; i < s.end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };

  return r;
}

function unzigzag(v) {
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

// decode(bytes, tile, classes) -> {<class>: [[lat, lon, lat, lon, ...], ...]} with a list of lines (at least two
// points each) for every class asked for. `bytes` is the tile (Uint8Array or array of bytes), `classes` the road
// classes wanted. Coordinates are rounded to seven decimals. Throws on a malformed tile.
function decode(bytes, tile, classes) {
  var out = {};
  var n = Math.pow(2, tile.z);
  var i;
  for (i = 0; i < classes.length; i++) out[classes[i]] = [];

  function layer(l) {
    var name = '';
    var extent = DEFAULT_EXTENT;
    var keys = [];
    var values = [];
    var features = [];
    var f, k, cls;

    l.fields(function (number, type) {
      if (number === 1 && type === 2) name = l.string();
      else if (number === 2 && type === 2) features.push(l.sub());
      else if (number === 3 && type === 2) keys.push(l.string());
      else if (number === 4 && type === 2) values.push(value(l.sub()));
      else if (number === 5 && type === 0) extent = l.varint();
      else return false;
      return true;
    });
    if (name !== LAYER) return;

    for (f = 0; f < features.length; f++) {
      features[f] = feature(features[f]);
      cls = null;
      for (k = 0; k + 1 < features[f].tags.length; k += 2) {
        if (keys[features[f].tags[k]] === CLASS_KEY) cls = values[features[f].tags[k + 1]];
      }
      if (features[f].type === 2 && typeof cls === 'string' && out.hasOwnProperty(cls) && features[f].geometry) {
        lines(features[f].geometry, extent, out[cls]);
      }
    }
  }

  // Only string values matter here (the class); others become null.
  function value(v) {
    var s = null;
    v.fields(function (number, type) {
      if (number === 1 && type === 2) { s = v.string(); return true; }
      return false;
    });
    return s;
  }

  function feature(f) {
    var o = { tags: [], type: 0, geometry: null };
    var packed;
    f.fields(function (number, type) {
      if (number === 2 && type === 2) {
        packed = f.sub();
        while (packed.pos < packed.end) o.tags.push(packed.varint());
      } else if (number === 3 && type === 0) {
        o.type = f.varint();
      } else if (number === 4 && type === 2) {
        o.geometry = f.sub();
      } else {
        return false;
      }
      return true;
    });
    return o;
  }

  // Geometry commands: MoveTo (1) starts a line, LineTo (2) continues it; the cursor runs through the feature.
  function lines(g, extent, into) {
    var x = 0;
    var y = 0;
    var line = null;
    var cmd, count, c;

    function flush() {
      if (line && line.length >= 4) into.push(line);
      line = null;
    }

    while (g.pos < g.end) {
      cmd = g.varint();
      count = Math.floor(cmd / 8);
      cmd = cmd % 8;
      if (cmd === 7) continue;
      if (cmd !== 1 && cmd !== 2) throw new Error('bad tile geometry');
      for (c = 0; c < count; c++) {
        x += unzigzag(g.varint());
        y += unzigzag(g.varint());
        if (cmd === 1) { flush(); line = []; }
        if (!line) line = [];
        line.push(latOf(tile.y + y / extent), lonOf(tile.x + x / extent));
      }
    }
    flush();
  }

  function lonOf(wx) {
    return Math.round((wx / n * 360 - 180) * UNITS_PER_DEG) / UNITS_PER_DEG;
  }

  function latOf(wy) {
    var t = Math.PI * (1 - 2 * wy / n);
    var lat = Math.atan((Math.exp(t) - Math.exp(-t)) / 2) * 180 / Math.PI;
    return Math.round(lat * UNITS_PER_DEG) / UNITS_PER_DEG;
  }

  var top = reader(bytes);
  top.fields(function (number, type) {
    if (number === 3 && type === 2) { layer(top.sub()); return true; }
    return false;
  });
  return out;
}

module.exports = {
  ZOOM: ZOOM,
  cover: cover,
  url: url,
  decode: decode
};
