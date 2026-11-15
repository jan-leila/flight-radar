// A fake phone for the session: recorded responses instead of the network, a clock and timers the test moves,
// and a watch that takes every message at once. Requests wait in a queue until the test answers them, so tests
// decide how roads and aircraft interleave.
'use strict';
const fx = require('./fixtures');
const protocol = require('../../src/common/protocol');
const { createSession } = require('../../src/common/session');

const TIERS = ['motorway', 'trunk', 'primary', 'secondary'];

// The recorded all-tiers response, split the way Overpass answers this app's one-tier queries (no tags).
let tierTexts = null;
function tierResponses() {
  if (tierTexts) return tierTexts;
  const elements = JSON.parse(fx.load().overpassText).elements;
  tierTexts = {};
  for (const tier of TIERS) {
    tierTexts[tier] = JSON.stringify({
      version: 0.6,
      elements: elements.filter(el => el.tags.highway === tier || el.tags.highway === tier + '_link')
        .map(el => ({ type: 'way', id: el.id, geometry: el.geometry }))
    });
  }
  return tierTexts;
}

function tierOfRequest(req) {
  const query = decodeURIComponent(String(req.body || '').replace(/^data=/, ''));
  const m = /\^\((\w+)\|\1_link\)\$/.exec(query);
  return m ? m[1] : null;
}

function httpError(message, status, retryAfter) {
  const err = new Error(message);
  if (status) err.status = status;
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

// options: position ({lat, lon} or an Error for locate), storage (object used as localStorage),
//          respond(req) -> text | Error | undefined (undefined: the recorded response), endpoints
function createPhone(options) {
  const opts = options || {};
  const data = fx.load();
  const phone = {
    now: data.clock,
    sent: [],          // every PAYLOAD, in order
    requests: [],      // every request made
    pending: [],       // requests not answered yet: {req, cb}
    timers: [],        // {fn, at}
    logs: [],
    storage: opts.storage || {},
    position: opts.position || fx.POSITION,
    backlog: 0
  };

  function recorded(req) {
    if (/interpreter$/.test(req.url)) return tierResponses()[tierOfRequest(req)];
    if (req.url.indexOf('https://api.adsb.lol/v2/') === 0) return data.planesText;
    const trace = /trace_recent_([0-9a-f]{6})\.json$/.exec(req.url);
    if (trace && data.traces[trace[1]]) return data.traces[trace[1]];
    return httpError('HTTP 404', 404);
  }

  phone.session = createSession({
    http: (req, cb) => { phone.requests.push(req); phone.pending.push({ req, cb }); },
    locate: cb => (phone.position instanceof Error ? cb(phone.position) : cb(null, phone.position.lat, phone.position.lon)),
    storage: {
      get: key => (key in phone.storage ? phone.storage[key] : null),
      set: (key, value) => {
        if (opts.storageLimit && value.length > opts.storageLimit) throw new Error('QuotaExceededError');
        phone.storage[key] = String(value);
      }
    },
    now: () => phone.now,
    setTimeout: (fn, ms) => { phone.timers.push({ fn, at: phone.now + ms }); },
    send: bytes => { phone.sent.push(bytes); },
    backlog: () => phone.backlog,
    log: text => { phone.logs.push(text); },
    endpoints: opts.endpoints
  });

  // Answers the oldest waiting request (or the oldest one matching `filter`). Returns false when none waits.
  phone.answer = filter => {
    const i = phone.pending.findIndex(p => !filter || filter(p.req));
    if (i < 0) return false;
    const { req, cb } = phone.pending.splice(i, 1)[0];
    let result = opts.respond ? opts.respond(req) : undefined;
    if (result === undefined) result = recorded(req);
    if (result instanceof Error) cb(result); else cb(null, result);
    return true;
  };
  // Answers requests, oldest first, until none waits.
  phone.drain = () => { while (phone.answer()) { /* next */ } };
  // Moves the clock and runs the timers that came due.
  phone.advance = ms => {
    phone.now += ms;
    for (;;) {
      const i = phone.timers.findIndex(t => t.at <= phone.now);
      if (i < 0) return;
      phone.timers.splice(i, 1)[0].fn();
    }
  };
  phone.watch = payload => phone.session.handle(protocol.decodeWatchMessage(payload));
  phone.hello = (screen, mi) => phone.watch({ CMD: protocol.CMD_HELLO, VAL: (screen.height << 22) | (screen.width << 12) | mi });
  phone.select = hex => phone.watch({ PAYLOAD: [protocol.SUBCMD_SELECT].concat(hex.match(/../g).map(b => parseInt(b, 16))) });
  // The messages sent since the last call.
  let mark = 0;
  phone.take = () => { const out = phone.sent.slice(mark); mark = phone.sent.length; return out; };
  return phone;
}

// Splits a run of messages into what a test asserts on.
function summarise(messages) {
  const out = { types: messages.map(m => m[0]), statuses: [], errors: [], trails: [], views: 0 };
  let rle = null;
  for (const m of messages) {
    if (m[0] === protocol.PAY_BEGIN) { out.begin = m; out.views++; }
    else if (m[0] === protocol.PAY_PLANES) out.planes = m;
    else if (m[0] === protocol.PAY_TRAIL) out.trails.push(m);
    else if (m[0] === protocol.PAY_STATUS) out.statuses.push(Buffer.from(m.slice(1)).toString('latin1'));
    else if (m[0] === protocol.PAY_ERROR) out.errors.push(Buffer.from(m.slice(1)).toString('latin1'));
    else if (m[0] === protocol.PAY_BITMAP_BEGIN) { out.bitmapBytes = m[1] | (m[2] << 8) | (m[3] << 16) | (m[4] << 24); rle = []; }
    else if (m[0] === protocol.PAY_BITMAP_CHUNK) rle = rle.concat(m.slice(1));
  }
  if (rle) out.rle = rle;
  return out;
}

// Run-length decoding as the watch does it (src/c/radar_model.c).
function decodeBitmap(rle, width, height) {
  const out = new Uint8Array(width * height).fill(0xC0);
  let pos = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    out.fill(rle[i], pos, Math.min(pos + rle[i + 1], out.length));
    pos += rle[i + 1];
  }
  return out;
}

module.exports = { TIERS, createPhone, summarise, decodeBitmap, httpError, tierOfRequest, tierResponses };
