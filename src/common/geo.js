// Pure geometry helpers shared by the phone-side modules (CONTRACTS.md §1). ES5, no dependencies.
// Distances are statute miles and positions are degrees, because the watch's zoom levels are in miles.

var GEO_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
var MILES_PER_DEG_LAT = 69;
var EARTH_RADIUS_MI = 3959;

function geohash(lat, lon, precision) {
  var latRange = [-90, 90];
  var lonRange = [-180, 180];
  var out = '';
  var bit = 0;
  var ch = 0;
  var even = true;
  var range, value, mid;
  while (out.length < precision) {
    range = even ? lonRange : latRange;
    value = even ? lon : lat;
    mid = (range[0] + range[1]) / 2;
    if (value >= mid) { ch = (ch << 1) | 1; range[0] = mid; } else { ch = ch << 1; range[1] = mid; }
    even = !even;
    bit++;
    if (bit === 5) { out += GEO_BASE32.charAt(ch); bit = 0; ch = 0; }
  }
  return out;
}

function milesBetween(lat1, lon1, lat2, lon2) {
  var d2r = Math.PI / 180;
  var dLat = (lat2 - lat1) * d2r;
  var dLon = (lon2 - lon1) * d2r;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

// Equirectangular projection around (lat0, lon0): `radiusPx` pixels span `visibleMi` miles. Returns a function
// (lat, lon) -> [dx, dy] in whole pixels from the centre, y growing southwards. The watch draws planes and trails
// at these offsets over a bitmap rendered with the same projector, so the multiplication order here is part of
// the contract: changing it moves pixels.
function projector(lat0, lon0, visibleMi, radiusPx) {
  var milesPerDegLon = MILES_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  var pxPerMile = radiusPx / visibleMi;
  return function (lat, lon) {
    var dx = (lon - lon0) * milesPerDegLon * pxPerMile;
    var dy = -(lat - lat0) * MILES_PER_DEG_LAT * pxPerMile;
    return [Math.round(dx) | 0, Math.round(dy) | 0];
  };
}

// [south, west, north, east] of the box reaching `mi` miles from the point in each direction.
function bbox(lat, lon, mi) {
  var dLat = mi / MILES_PER_DEG_LAT;
  var dLon = mi / (MILES_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

module.exports = {
  geohash: geohash,
  milesBetween: milesBetween,
  projector: projector,
  bbox: bbox
};
