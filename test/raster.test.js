// src/common/raster.js: which pixels a road paints, the position dot, run-length encoding.
const test = require('node:test');
const assert = require('node:assert/strict');
const raster = require('../src/common/raster');
const roads = require('../src/common/roads');

const BG = raster.COLOR_BACKGROUND, ROAD = raster.COLOR_ROAD, YOU = raster.COLOR_YOU;

// A store with one way of `tier` whose points land on the given pixel offsets from the centre at 1 px per unit:
// with the centre at (0, 0), 69 visible miles and a 69 px radius, 1 px is 1/69 degree of latitude.
function storeWith(tier, pixels) {
  const store = roads.createStore();
  roads.addElements(store, tier, [{ type: 'way', geometry: pixels.map(([x, y]) => ({ lat: -y / 69, lon: x / 69 })) }]);
  return store;
}

function render(store, w, h) {
  const canvas = raster.createRaster(w, h);
  return canvas.render(store, 0, 0, 69, 69);
}

// The painted pixels as rows of text, without the position dot: '#' road, '.' background.
function picture(buf, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += buf[y * w + x] === ROAD ? '#' : buf[y * w + x] === YOU ? 'o' : '.';
    rows.push(row);
  }
  return rows;
}

test('an empty map is background with the position dot in the middle', () => {
  const buf = render(null, 11, 9);
  assert.deepEqual(picture(buf, 11, 9), [
    '...........',
    '.....o.....',
    '...ooooo...',
    '...ooooo...',
    '..ooooooo..',
    '...ooooo...',
    '...ooooo...',
    '.....o.....',
    '...........'
  ]);
  assert.equal(buf[0], BG);
});

test('major roads are two pixels wide: the extra pixel is below a flat line and right of a steep one', () => {
  // centre of a 20 x 20 bitmap is (10, 10); keep clear of the dot
  const flat = picture(render(storeWith('motorway', [[-9, -8], [-4, -7]]), 20, 20), 20, 20);
  assert.deepEqual(flat.slice(1, 5), [
    '....................',
    '.###................',
    '.######.............',
    '....###.............'
  ]);
  const steep = picture(render(storeWith('trunk', [[-8, -9], [-7, -5]]), 20, 20), 20, 20);
  assert.deepEqual(steep.slice(0, 7), [
    '....................',
    '..##................',
    '..##................',
    '..##................',
    '...##...............',
    '...##...............',
    '....................'
  ]);
});

test('minor roads are one pixel wide and drawn on every other pixel of a checkerboard', () => {
  for (const tier of ['primary', 'secondary']) {
    const rows = picture(render(storeWith(tier, [[-9, -8], [0, -8]]), 20, 20), 20, 20);
    assert.equal(rows[2], '..#.#.#.#.#.........', tier);
    assert.equal(rows[3], '....................', tier);
    // a diagonal stays on one colour of the checkerboard: all of it or none of it
    assert.equal(picture(render(storeWith(tier, [[-9, -9], [-5, -5]]), 20, 20), 20, 20).slice(1, 6).join(''),
      '.#..................' + '..#.................' + '...#................' + '....#...............' + '.....#..............');
    assert.ok(!picture(render(storeWith(tier, [[-8, -9], [-4, -5]]), 20, 20), 20, 20).join('').includes('#'));
  }
});

test('major roads paint over minor ones whatever the order they were added in', () => {
  const store = roads.createStore();
  const across = [{ type: 'way', geometry: [{ lat: 8 / 69, lon: -9 / 69 }, { lat: 8 / 69, lon: 0 }] }];
  roads.addElements(store, 'motorway', across);
  roads.addElements(store, 'secondary', across);
  assert.equal(picture(render(store, 20, 20), 20, 20)[2], '.##########.........');
});

test('lines are clipped at the edges and may start far outside', () => {
  const rows = picture(render(storeWith('motorway', [[-500, -9], [500, -9]]), 20, 20), 20, 20);
  assert.equal(rows[1], '####################');
  assert.equal(rows[2], '####################');
  assert.equal(rows[0], '....................');
  // entirely off one side: nothing, and it does not take long
  const off = render(storeWith('motorway', [[30, -100000], [30, 100000]]), 20, 20);
  assert.ok(!picture(off, 20, 20).join('').includes('#'));
});

test('a way of one point paints nothing; ways are not joined to each other', () => {
  const store = roads.createStore();
  roads.addElements(store, 'motorway', [
    { type: 'way', geometry: [{ lat: 8 / 69, lon: -8 / 69 }] },
    { type: 'way', geometry: [{ lat: 8 / 69, lon: 4 / 69 }, { lat: 8 / 69, lon: 6 / 69 }] }
  ]);
  assert.equal(picture(render(store, 20, 20), 20, 20)[2], '..............###...');
});

test('render() starts from a clean bitmap each time', () => {
  const canvas = raster.createRaster(20, 20);
  canvas.render(storeWith('motorway', [[-9, -8], [0, -8]]), 0, 0, 69, 69);
  const again = canvas.render(null, 0, 0, 69, 69);
  assert.ok(!picture(again, 20, 20).join('').includes('#'));
});

test('rleEncode: (colour, count) pairs, runs longer than 255 are split', () => {
  assert.deepEqual(raster.rleEncode(Uint8Array.from([7, 7, 7, 9, 7])), [7, 3, 9, 1, 7, 1]);
  assert.deepEqual(raster.rleEncode(new Uint8Array(600).fill(BG)), [BG, 255, BG, 255, BG, 90]);
  assert.deepEqual(raster.rleEncode(new Uint8Array(0)), []);
});
