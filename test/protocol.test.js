// src/common/protocol.js: the bytes of every message to the watch, the watch's commands, the send queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/common/protocol');

const text = bytes => Buffer.from(bytes).toString('latin1');
const i16 = (bytes, at) => Buffer.from(bytes).readInt16LE(at);
const identity = (lat, lon) => [lon, lat];           // "positions" in pixels: lat is y, lon is x
const plane = fields => Object.assign({ hex: 'abc123', lat: 0, lon: 0, alt: 0, gs: 0, track: 0, callsign: '', tail: '', type: '' }, fields);

test('PAY_BEGIN: position in microdegrees, zoom, road status, plane count, geohash', () => {
  const m = protocol.encodeBegin(44.9778, -93.265, 20, 4, 7, '9zvxv');
  assert.equal(m.length, 20);
  const b = Buffer.from(m);
  assert.equal(b[0], protocol.PAY_BEGIN);
  assert.equal(b.readInt32LE(1), 44977800);
  assert.equal(b.readInt32LE(5), -93265000);
  assert.equal(b.readUInt16LE(9), 20);
  assert.equal(b.readUInt16LE(11), 4);
  assert.equal(b.readUInt16LE(13), 7);
  assert.equal(text(m.slice(15)), '9zvxv');
  assert.deepEqual(protocol.encodeBegin(0, 0, 5, 0, 0, 'ab').slice(15), [97, 98, 0, 0, 0]);
});

test('status and error texts are cut at 60 characters', () => {
  assert.deepEqual(protocol.encodeStatus('Hi'), [protocol.PAY_STATUS, 72, 105]);
  assert.deepEqual(protocol.encodeError(''), [protocol.PAY_ERROR]);
  assert.equal(protocol.encodeError('x'.repeat(100)).length, 61);
  assert.deepEqual(protocol.encodeEnd(), [protocol.PAY_END]);
});

test('bitmap: the size first, then chunks that fill one message each', () => {
  const rle = Array.from({ length: 2500 }, (_, i) => i % 251);
  const messages = protocol.encodeBitmap(rle);
  assert.deepEqual(messages[0], [protocol.PAY_BITMAP_BEGIN, 0xc4, 0x09, 0, 0]);
  assert.deepEqual(messages.slice(1).map(m => m.length), [1024, 1024, 455]);
  assert.ok(messages.slice(1).every(m => m[0] === protocol.PAY_BITMAP_CHUNK));
  assert.deepEqual([].concat(...messages.slice(1).map(m => m.slice(1))), rle);
  assert.deepEqual(protocol.encodeBitmap([]), [[protocol.PAY_BITMAP_BEGIN, 0, 0, 0, 0]]);
  assert.equal(protocol.encodeBitmap(new Array(1023).fill(1)).length, 2);
  assert.equal(protocol.encodeBitmap(new Array(1024).fill(1)).length, 3);
});

test('a plane is a 36-byte record', () => {
  const m = protocol.encodePlanes([plane({
    hex: 'ac9abc', lat: -14, lon: 12, alt: 12300, gs: 305.6, track: 90, callsign: 'dal2446', tail: 'N140DU', type: 'BCS1'
  })], identity, null, []);
  assert.equal(m.length, 2 + 36);
  assert.deepEqual(m.slice(0, 2), [protocol.PAY_PLANES, 1]);
  const r = m.slice(2);
  assert.deepEqual(r.slice(0, 3), [0xac, 0x9a, 0xbc]);
  assert.equal(i16(r, 3), 12);
  assert.equal(i16(r, 5), -14);
  assert.equal(r[7], 1, 'altitude band');
  assert.equal(r[8], 64, 'a quarter turn');
  assert.equal(text(r.slice(9, 17)), 'DAL2446\0', 'upper case, NUL padded');
  assert.equal(text(r.slice(17, 25)), 'N140DU\0\0');
  assert.equal(text(r.slice(25, 31)), 'BCS1\0\0');
  assert.equal(i16(r, 31), 123);
  assert.equal(Buffer.from(r).readUInt16LE(33), 306);
  assert.equal(r[35], 0, 'no trail');
});

test('altitude bands, heading wrap-around, clamping and long names', () => {
  const band = alt => protocol.encodePlanes([plane({ alt })], identity, null, [])[2 + 7];
  assert.deepEqual([0, 12000, 12001, 28000, 28001, 45000].map(band), [0, 0, 1, 1, 2, 2]);
  const heading = track => protocol.encodePlanes([plane({ track })], identity, null, [])[2 + 8];
  assert.deepEqual([0, 359.9, 360, 180, -90, 1.4].map(heading), [0, 0, 0, 128, 192, 1]);
  const r = protocol.encodePlanes([plane({ alt: 9999999, gs: 99999, callsign: 'ABCDEFGHIJ', type: 'TOOLONG7' })], identity, null, []).slice(2);
  assert.equal(i16(r, 31), 32767);
  assert.equal(Buffer.from(r).readUInt16LE(33), 65535);
  assert.equal(text(r.slice(9, 17)), 'ABCDEFGH');
  assert.equal(text(r.slice(25, 31)), 'TOOLON');
});

test('planes more than 200 px from the centre are left out; at most 48 are sent', () => {
  const far = protocol.encodePlanes([plane({ lon: 201 }), plane({ lat: -201 }), plane({ lon: 200, lat: -200 })], identity, null, []);
  assert.equal(far[1], 1);
  const many = Array.from({ length: 60 }, (_, i) => plane({ hex: 'a000' + (10 + i), lon: i }));
  const m = protocol.encodePlanes(many, identity, null, []);
  assert.equal(m[1], 48);
  assert.equal(m.length, 2 + 48 * 36);
  assert.ok(m.length + 64 < 2048, 'fits a small inbox even with a full trail');
});

test('only the selected plane carries its trail', () => {
  const trail = [{ lat: 5, lon: -5 }, { lat: 1001, lon: 0 }, { lat: 3, lon: -3 }];
  const m = protocol.encodePlanes([plane({ hex: 'aaaaaa' }), plane({ hex: 'bbbbbb' })], identity, 'bbbbbb', trail);
  assert.equal(m.length, 2 + 36 + 36 + 2 * 4);
  assert.equal(m[2 + 35], 0);
  assert.equal(m[2 + 36 + 35], 2, 'the point more than 1000 px away is dropped');
  const points = m.slice(2 + 72);
  assert.deepEqual([i16(points, 0), i16(points, 2), i16(points, 4), i16(points, 6)], [-5, 5, -3, 3]);
});

test('PAY_TRAIL: address, count, points', () => {
  const m = protocol.encodeTrail('ac9abc', [{ lat: -2, lon: 7 }, { lat: 300, lon: -300 }], identity);
  assert.deepEqual(m.slice(0, 5), [protocol.PAY_TRAIL, 0xac, 0x9a, 0xbc, 2]);
  assert.deepEqual([i16(m, 5), i16(m, 7), i16(m, 9), i16(m, 11)], [7, -2, -300, 300]);
  assert.deepEqual(protocol.encodeTrail('ac9abc', [], identity), [protocol.PAY_TRAIL, 0xac, 0x9a, 0xbc, 0]);
});

test('decodeWatchMessage', () => {
  const d = protocol.decodeWatchMessage;
  assert.deepEqual(d({ CMD: 1, VAL: (228 << 22) | (200 << 12) | 20 }), { type: 'hello', visibleMi: 20, width: 200, height: 228 });
  assert.deepEqual(d({ CMD: 1, VAL: (260 << 22) | (260 << 12) | 20 }), { type: 'hello', visibleMi: 20, width: 260, height: 260 });
  assert.deepEqual(d({ CMD: 1 }), { type: 'hello', visibleMi: 0, width: 0, height: 0 });
  assert.deepEqual(d({ CMD: 2, VAL: 0 }), { type: 'refreshPlanes' });
  assert.deepEqual(d({ CMD: 3, VAL: 40 }), { type: 'refreshAll', visibleMi: 40 });
  assert.deepEqual(d({ CMD: 4, VAL: 5 }), { type: 'view', visibleMi: 5 });
  assert.deepEqual(d({ CMD: 4, VAL: -3 }), { type: 'view', visibleMi: 0 });
  assert.deepEqual(d({ PAYLOAD: [0x80, 0xac, 0x9a, 0x0c] }), { type: 'select', hex: 'ac9a0c' });
  assert.equal(d({ PAYLOAD: [0x80, 1, 2] }), null);
  assert.equal(d({ PAYLOAD: [0x7f, 1, 2, 3] }), null);
  assert.equal(d({ CMD: 9 }), null);
  assert.equal(d({}), null);
  assert.equal(d(undefined), null);
});

// A watch for the sender: `outcomes` are consumed one per send attempt ('ack' or 'nack'), 'ack' when exhausted.
function watch(outcomes) {
  const attempts = [];
  const timers = [];
  const sender = protocol.createSender({
    send: (dict, ack, nack) => { attempts.push(dict.PAYLOAD[0]); w.reply = (outcomes.shift() || 'ack') === 'ack' ? ack : nack; },
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  });
  const w = { sender, attempts, timers, reply: null };
  return w;
}

test('sender: one message at a time, in order', () => {
  const w = watch([]);
  w.sender.send([1]); w.sender.send([2]); w.sender.send([3]);
  assert.deepEqual(w.attempts, [1]);
  assert.equal(w.sender.pending(), 3);
  w.reply();
  assert.deepEqual(w.attempts, [1, 2]);
  w.reply(); w.reply();
  assert.deepEqual(w.attempts, [1, 2, 3]);
  assert.equal(w.sender.pending(), 0);
  w.sender.send([4]);
  assert.deepEqual(w.attempts, [1, 2, 3, 4]);
});

test('sender: an unacknowledged message is retried twice, half a second apart, then dropped', () => {
  const w = watch(['nack', 'nack', 'nack', 'ack', 'nack', 'ack']);
  w.sender.send([1]); w.sender.send([2]); w.sender.send([3]);
  w.reply();
  assert.deepEqual(w.attempts, [1], 'waits before retrying');
  assert.equal(w.timers[0].ms, 500);
  w.timers.shift().fn();
  w.reply();
  w.timers.shift().fn();
  assert.deepEqual(w.attempts, [1, 1, 1]);
  w.reply();                                     // third failure: give up on 1, go on with 2
  assert.deepEqual(w.attempts, [1, 1, 1, 2]);
  assert.equal(w.timers.length, 0);
  w.reply();                                     // 2 acknowledged; 3 fails once, then succeeds: the count starts over
  w.reply();
  w.timers.shift().fn();
  w.reply();
  assert.deepEqual(w.attempts, [1, 1, 1, 2, 3, 3]);
  assert.equal(w.sender.pending(), 0);
});
