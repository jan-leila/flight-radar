// src/common/geo.js: geohash, distance, the projection the map and the planes share, bounding box.
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/common/geo');

test('geohash matches well-known hashes', () => {
  assert.equal(geo.geohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
  assert.equal(geo.geohash(44.9778, -93.2650, 5), '9zvxv');
  assert.equal(geo.geohash(0, 0, 3), 's00');
  assert.equal(geo.geohash(-90, -180, 4), '0000');
});

test('milesBetween: a degree of latitude is about 69 miles', () => {
  assert.ok(Math.abs(geo.milesBetween(44, -93, 45, -93) - 69.1) < 0.1);
  assert.equal(geo.milesBetween(44.5, -93.2, 44.5, -93.2), 0);
  // a degree of longitude shrinks with the cosine of the latitude
  assert.ok(Math.abs(geo.milesBetween(60, 10, 60, 11) - 34.55) < 0.1);
});

test('projector: radius pixels span the visible miles, north is up, east is right', () => {
  const project = geo.projector(45, -93, 20, 100);
  assert.deepEqual(project(45, -93), [0, 0]);
  assert.deepEqual(project(45 + 20 / 69, -93), [0, -100]);
  assert.deepEqual(project(45 - 10 / 69, -93), [0, 50]);
  const east = project(45, -93 + 20 / (69 * Math.cos(45 * Math.PI / 180)));
  assert.deepEqual(east, [100, 0]);
});

test('projector rounds to whole pixels, halves away from the top-left', () => {
  const project = geo.projector(0, 0, 69, 100);  // 100 px per degree of latitude
  assert.deepEqual(project(-0.004, 0.004), [0, 0]);
  assert.deepEqual(project(-0.006, 0.006), [1, 1]);
  assert.deepEqual(project(0.006, -0.006), [-1, -1]);
  // zoom changes scale, not the centre
  assert.deepEqual(geo.projector(0, 0, 34.5, 100)(-0.006, 0.006), [1, 1]);
});

test('bbox reaches the given miles in every direction', () => {
  const [s, w, n, e] = geo.bbox(44.9778, -93.2650, 40);
  assert.ok(Math.abs((n - s) * 69 - 80) < 1e-9);
  assert.ok(Math.abs(geo.milesBetween(44.9778, w, 44.9778, e) - 80) < 0.5);
  assert.ok(Math.abs((n + s) / 2 - 44.9778) < 1e-9 && Math.abs((e + w) / 2 + 93.2650) < 1e-9);
});
