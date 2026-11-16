// src/common/tiles.js: which tiles cover a box, and the road lines of a vector tile.
const test = require('node:test');
const assert = require('node:assert/strict');
const tiles = require('../src/common/tiles');
const geo = require('../src/common/geo');
const mvt = require('./helpers/mvt');

const CLASSES = ['motorway', 'trunk', 'primary', 'secondary'];

test('cover: the zoom 9 tiles of the box, north to south, west to east', () => {
  const box = geo.bbox(44.9778, -93.2650, 40);
  assert.deepEqual(tiles.cover(box).map(t => `${t.z}/${t.x}/${t.y}`), [
    '9/122/183', '9/123/183', '9/124/183', '9/122/184', '9/123/184', '9/124/184', '9/122/185', '9/123/185', '9/124/185'
  ]);
  assert.deepEqual(tiles.cover([10, 10, 10.1, 10.1], 0), [{ z: 0, x: 0, y: 0 }]);
});

test('cover and url: a box across the antimeridian keeps its columns in order and wraps their addresses', () => {
  const cover = tiles.cover([0.1, 179.9, 0.2, 180.1], 2);
  assert.deepEqual(cover.map(t => t.x), [3, 4]);
  assert.deepEqual(cover.map(t => tiles.url('https://t/{z}/{x}/{y}.pbf', t)), ['https://t/2/3/1.pbf', 'https://t/2/0/1.pbf']);
  assert.equal(tiles.url('https://t/{z}/{x}/{y}.pbf', { z: 2, x: -1, y: 0 }), 'https://t/2/3/0.pbf');
});

test('cover: latitudes beyond the projection stay in the top and bottom rows', () => {
  assert.deepEqual(tiles.cover([-89, 0, 89, 1], 1).map(t => t.y), [0, 1]);
});

test('decode: lines of the wanted classes from the transportation layer, in degrees with seven decimals', () => {
  const bytes = mvt.tile([
    { name: 'water', features: [{ props: { class: 'motorway' }, lines: [[[0, 0], [10, 10]]] }] },
    {
      name: 'transportation',
      features: [
        { props: { class: 'motorway', ramp: 1 }, lines: [[[0, 0], [2048, 2048], [4096, 4096]]] },
        { props: { class: 'rail' }, lines: [[[0, 0], [5, 5]]] },
        { props: { class: 'secondary', surface: 'paved' }, lines: [[[100, 100], [200, 100]], [[-64, 300], [0, 300], [50, 310]]] },
        { type: 3, props: { class: 'primary' }, lines: [[[0, 0], [10, 0], [10, 10]]] },
        { props: { network: 'us-interstate' }, lines: [[[0, 0], [5, 5]]] }
      ]
    }
  ]);
  const out = tiles.decode(bytes, { z: 1, x: 0, y: 0 }, CLASSES);
  // tile 1/0/0 is the north-western quarter of the world
  assert.deepEqual(out.motorway, [[85.0511288, -180, 66.5132604, -90, 0, 0]]);
  assert.equal(out.secondary.length, 2);
  assert.equal(out.secondary[1].length, 6);
  assert.ok(out.secondary[1][1] < -180, 'points in the tile buffer lie beyond its edge');
  assert.deepEqual(out.primary, []);
  assert.deepEqual(out.trunk, []);
  for (const v of out.secondary[0]) assert.equal(Math.round(v * 1e7) / 1e7, v);
});

test('decode: the layer extent, keys before features, and tiles east of the antimeridian column', () => {
  const layers = [{ name: 'transportation', extent: 512, features: [{ props: { class: 'trunk' }, lines: [[[0, 256], [512, 256]]] }] }];
  const a = tiles.decode(mvt.tile(layers), { z: 0, x: 0, y: 0 }, CLASSES);
  assert.deepEqual(a.trunk, [[0, -180, 0, 180]]);
  assert.deepEqual(tiles.decode(mvt.tile(layers, true), { z: 0, x: 0, y: 0 }, CLASSES), a);
  // column 1 of zoom 0 is the world again, one turn further east
  assert.deepEqual(tiles.decode(mvt.tile(layers), { z: 0, x: 1, y: 0 }, CLASSES).trunk, [[0, 180, 0, 540]]);
});

test('decode: a line needs two points; an empty tile has no roads', () => {
  const bytes = mvt.tile([{ name: 'transportation', features: [{ props: { class: 'trunk' }, lines: [[[5, 5]]] }] }]);
  assert.deepEqual(tiles.decode(bytes, { z: 3, x: 1, y: 1 }, CLASSES).trunk, []);
  assert.deepEqual(tiles.decode(new Uint8Array(0), { z: 3, x: 1, y: 1 }, ['trunk']), { trunk: [] });
});

test('decode: a cut-off or foreign body throws', () => {
  const bytes = mvt.tile([{ name: 'transportation', features: [{ props: { class: 'trunk' }, lines: [[[0, 0], [9, 9]]] }] }]);
  assert.throws(() => tiles.decode(bytes.slice(0, bytes.length - 3), { z: 0, x: 0, y: 0 }, CLASSES));
  assert.throws(() => tiles.decode(new Uint8Array(Buffer.from('<html>busy</html>')), { z: 0, x: 0, y: 0 }, CLASSES));
});
