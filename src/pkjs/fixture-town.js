// A made-up town for the test entries (ui-fixture.js, app-fixture.js): a ring motorway, a motorway and two trunk
// roads through the centre, a grid of primary roads and a denser grid of secondary ones. ES5.

var CENTER = { lat: 44.9778, lon: -93.2650 };

// Offsets in miles east and north of the centre -> an Overpass `way` element.
function way(points) {
  var k = 69 * Math.cos(CENTER.lat * Math.PI / 180);
  return {
    type: 'way',
    geometry: points.map(function (p) {
      // seven decimals, as OSM has them
      return { lat: Math.round((CENTER.lat + p[1] / 69) * 1e7) / 1e7, lon: Math.round((CENTER.lon + p[0] / k) * 1e7) / 1e7 };
    })
  };
}

// The `elements` of the town's roads of one tier.
function elements(tier) {
  var out = [];
  var ring = [];
  var i;
  if (tier === 'motorway') {
    for (i = 0; i <= 48; i++) ring.push([9 * Math.cos(i * Math.PI / 24), 7 * Math.sin(i * Math.PI / 24)]);
    out.push(way(ring), way([[-30, -22], [-9, -6], [0, 1], [8, 5], [30, 24]]));
  } else if (tier === 'trunk') {
    out.push(way([[-30, 6], [-12, 2], [0, -1], [14, -3], [30, -12]]), way([[3, -30], [1, -8], [-2, 9], [-6, 30]]));
  } else if (tier === 'primary') {
    for (i = -4; i <= 4; i++) {
      out.push(way([[i * 5, -24], [i * 5 + 1, 0], [i * 5, 24]]));
      out.push(way([[-24, i * 5], [0, i * 5 - 1], [24, i * 5]]));
    }
  } else if (tier === 'secondary') {
    for (i = -11; i <= 11; i++) {
      out.push(way([[i * 1.5, -12], [i * 1.5, 12]]));
      out.push(way([[-12, i * 1.5], [12, i * 1.5]]));
    }
  }
  return out;
}

module.exports = { CENTER: CENTER, elements: elements };
