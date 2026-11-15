// Records what the ORIGINAL app's phone-side code sends to the watch for the recorded responses in
// test/fixtures/, as test/fixtures/reference-streams.json. test/parity.test.js then requires this app to send
// the same bytes for the same situation.
//
// usage (inside nix-shell): node tools/reference-streams.js
//
// The original's JavaScript is not part of this repository: tools/reference.py fetches the .pbw (checksum pinned)
// and this script runs its pebble-js-app.js in a sandbox whose XMLHttpRequest, geolocation, localStorage, clock
// and Pebble object are the fixtures. Per screen size it replays: hello at 20 mi, the other zoom levels, a
// selection with a recorded trace, and a planes-only refresh 31 s later.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const fx = require('../test/helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'reference-streams.json');
const hex = bytes => Buffer.from(bytes).toString('hex');
const sha256 = bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function originalSource() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plane-watch-ref-')), 'pebble-js-app.js');
  execFileSync('python3', [path.join(__dirname, 'reference.py'), 'pkjs', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  const text = fs.readFileSync(file, 'utf8');
  return { text, sha256: sha256(Buffer.from(text)) };
}

// One run of the original's code on a fake phone. Everything asynchronous goes through `later`, so idle()
// resolves once the code has nothing left to do.
function createPhone(source) {
  const data = fx.load();
  let now = data.clock;
  let busy = 0;
  const sent = [];
  const handlers = {};
  const storage = {};
  const later = (fn, ms) => { busy++; setTimeout(() => { busy--; fn(); }, ms || 0); };

  function respond(url) {
    if (url.includes('overpass')) return data.overpassText;
    if (url.includes('api.adsb.lol/v2/')) return data.planesText;
    const trace = /trace_recent_([0-9a-f]{6})\.json/.exec(url);
    return trace ? data.traces[trace[1]] : undefined;
  }

  class XMLHttpRequest {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    send() {
      later(() => {
        const text = respond(this.url);
        if (text === undefined) { this.status = 404; this.responseText = ''; } else { this.status = 200; this.responseText = text; }
        this.onload();
      });
    }
  }

  const sandbox = {
    console: { log() {}, error() {} },
    setTimeout: (fn, ms) => later(fn, Math.min(ms, 5)),
    XMLHttpRequest,
    navigator: {
      geolocation: {
        getCurrentPosition: ok => later(() => ok({ coords: { latitude: fx.POSITION.lat, longitude: fx.POSITION.lon } }))
      }
    },
    localStorage: {
      getItem: key => (key in storage ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); }
    },
    Pebble: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      sendAppMessage: (dict, ack) => { sent.push(Array.from(dict.PAYLOAD)); later(ack); }
    },
    __now: () => now
  };
  vm.createContext(sandbox);
  vm.runInContext('Date.now = function () { return __now(); };', sandbox);
  vm.runInContext(source, sandbox, { filename: 'pebble-js-app.js' });
  handlers.ready();

  return {
    sent,
    advance: ms => { now += ms; },
    watch: payload => handlers.appmessage({ payload }),
    idle: () => new Promise(resolve => {
      const poll = () => (busy ? setTimeout(poll, 5) : resolve());
      setTimeout(poll, 5);
    })
  };
}

// The messages sent since `from`, by kind. The bitmap is kept as its size and digest only.
function summarise(messages) {
  const out = { statuses: [] };
  let rle = [];
  for (const m of messages) {
    if (m[0] === 0x01) out.begin = hex(m);
    else if (m[0] === 0x03) out.planes = hex(m);
    else if (m[0] === 0x09) (out.trails || (out.trails = [])).push(hex(m));
    else if (m[0] === 0x04 || m[0] === 0x05) out.statuses.push(Buffer.from(m.slice(1)).toString('latin1'));
    else if (m[0] === 0x07) { out.bitmapBytes = m[1] | (m[2] << 8) | (m[3] << 16) | (m[4] << 24); rle = []; }
    else if (m[0] === 0x08) rle = rle.concat(m.slice(1));
  }
  if (out.bitmapBytes !== undefined) {
    if (rle.length !== out.bitmapBytes) throw new Error('bitmap of ' + rle.length + ' bytes announced as ' + out.bitmapBytes);
    out.bitmapSha256 = sha256(rle);
  }
  return out;
}

async function record(source, screen) {
  const phone = createPhone(source);
  const cases = {};
  let mark = 0;
  const step = async (name, payload) => {
    phone.watch(payload);
    await phone.idle();
    cases[name] = summarise(phone.sent.slice(mark));
    mark = phone.sent.length;
  };
  await step('hello', { CMD: 1, VAL: (screen.height << 22) | (screen.width << 12) | fx.ZOOMS[0] });
  for (const mi of fx.ZOOMS.slice(1)) await step('view-' + mi, { CMD: 4, VAL: mi });
  await step('view-' + fx.ZOOMS[0], { CMD: 4, VAL: fx.ZOOMS[0] });
  for (const h of fx.TRACED) {
    await step('select-' + h, { PAYLOAD: [0x80, parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)] });
  }
  phone.advance(fx.REFRESH_AFTER_MS);
  await step('refresh', { CMD: 2, VAL: 0 });
  await step('hello-again', { CMD: 1, VAL: (screen.height << 22) | (screen.width << 12) | fx.ZOOMS[0] });
  return cases;
}

(async () => {
  const source = originalSource();
  const out = { original: { version: '0.4.1', pkjsSha256: source.sha256 }, screens: {} };
  for (const screen of fx.SCREENS) out.screens[screen.name] = await record(source.text, screen);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  for (const [name, cases] of Object.entries(out.screens)) {
    console.log(name + ': ' + Object.entries(cases).map(([k, c]) => k + (c.bitmapBytes ? ' (' + c.bitmapBytes + ' B map)' : '')).join(', '));
  }
  console.log('wrote ' + path.relative(ROOT, OUT));
})().catch(e => { console.error(e); process.exit(1); });
