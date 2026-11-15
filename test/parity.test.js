// The phone side has to send the watch the very bytes the original app sends in the same situation: the same
// map bitmap at every zoom level and screen size, the same aircraft records, the same flight paths.
// test/fixtures/reference-streams.json was recorded from the original's code (tools/reference-streams.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fx = require('./helpers/fixtures');
const { createPhone, summarise } = require('./helpers/phone');
const reference = require('./fixtures/reference-streams.json');

const hex = bytes => Buffer.from(bytes).toString('hex');
const sha256 = bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function sameView(got, want, what) {
  assert.equal(hex(got.begin), want.begin, what + ': PAY_BEGIN');
  assert.equal(got.rle.length, want.bitmapBytes, what + ': bitmap size');
  assert.equal(sha256(got.rle), want.bitmapSha256, what + ': bitmap');
  assert.equal(hex(got.planes), want.planes, what + ': PAY_PLANES');
}

for (const screen of fx.SCREENS) {
  const want = reference.screens[screen.name];

  test(`${screen.name}: same bytes as the original for every view, selection and refresh`, () => {
    const phone = createPhone();
    phone.hello(screen, fx.ZOOMS[0]);
    phone.drain();
    // The original sends one view once everything is there; here the last view sent is the complete one.
    const all = phone.take();
    const lastBegin = all.map(m => m[0]).lastIndexOf(1);
    sameView(summarise(all.slice(lastBegin)), want.hello, 'hello');

    for (const mi of fx.ZOOMS.slice(1).concat(fx.ZOOMS[0])) {
      phone.watch({ CMD: 4, VAL: mi });
      sameView(summarise(phone.take()), want['view-' + mi], mi + ' mi');
    }

    for (const h of fx.TRACED) {
      phone.select(h);
      phone.drain();
      assert.deepEqual(summarise(phone.take()).trails.map(hex), want['select-' + h].trails, 'flight path of ' + h);
    }

    phone.advance(fx.REFRESH_AFTER_MS);
    phone.watch({ CMD: 2, VAL: 0 });
    phone.drain();
    const refresh = summarise(phone.take());
    assert.equal(refresh.views, 0, 'a refresh sends no map');
    assert.equal(hex(refresh.planes), want.refresh.planes, 'refresh: PAY_PLANES with the selected plane\'s path');

    phone.hello(screen, fx.ZOOMS[0]);
    phone.drain();
    sameView(summarise(phone.take()), want['hello-again'], 'second hello');
  });
}

test('the reference covers both screens and all four zoom levels', () => {
  assert.deepEqual(Object.keys(reference.screens).sort(), fx.SCREENS.map(s => s.name).sort());
  for (const cases of Object.values(reference.screens)) {
    for (const mi of fx.ZOOMS) assert.match(cases['view-' + mi].bitmapSha256, /^[0-9a-f]{64}$/);
  }
});
