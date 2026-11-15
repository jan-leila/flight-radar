// PebbleKit JS entry: the composition root. Wires the session to the phone (XMLHttpRequest, geolocation,
// localStorage) and to the watch (AppMessage). ES5; everything with logic in it lives in src/common/.

var protocol = require('../common/protocol');
var session = require('../common/session');

// A position from the last ten minutes is as good as a new one at this scale, and a phone without network
// location can need most of half a minute for a first fix.
var GPS_OPTIONS = { enableHighAccuracy: false, timeout: 30000, maximumAge: 600000 };
// Overpass asks clients to identify themselves. Runtimes that do not let a page set this header keep their own.
var USER_AGENT = 'plane-watch (Pebble watchapp)';

function http(req, cb) {
  var xhr = new XMLHttpRequest();
  var done = false;

  function finish(err, text) {
    if (done) return;
    done = true;
    cb(err, text);
  }

  function failure(message) {
    return function () { finish(new Error(message)); };
  }

  xhr.open(req.method, req.url, true);
  try { xhr.setRequestHeader('User-Agent', USER_AGENT); } catch (e) { /* forbidden header here */ }
  xhr.timeout = req.timeout;
  xhr.onload = function () {
    var err, retryAfter;
    if (xhr.status >= 200 && xhr.status < 300) { finish(null, xhr.responseText); return; }
    err = new Error('HTTP ' + xhr.status);
    err.status = xhr.status;
    retryAfter = xhr.getResponseHeader && xhr.getResponseHeader('Retry-After');
    err.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
    finish(err);
  };
  xhr.onerror = failure('network');
  xhr.ontimeout = failure('timeout');
  if (req.body) {
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.send(req.body);
  } else {
    xhr.send();
  }
}

function locate(cb) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { cb(new Error('no geolocation')); return; }
  navigator.geolocation.getCurrentPosition(
    function (pos) { cb(null, pos.coords.latitude, pos.coords.longitude); },
    function (err) { cb(new Error('GPS err ' + err.code)); },
    GPS_OPTIONS);
}

var sender = protocol.createSender({
  send: function (dict, onAck, onNack) { Pebble.sendAppMessage(dict, onAck, onNack); },
  setTimeout: function (fn, ms) { setTimeout(fn, ms); },
  log: function (text) { console.log(text); }
});

var app = null;

Pebble.addEventListener('ready', function () {
  // The watch says hello with its screen size when the app opens and repeats it until it gets an answer, so
  // nothing is fetched before that: the map has to be rendered at the size of the screen it is for.
  app = session.createSession({
    http: http,
    locate: locate,
    storage: {
      get: function (key) { return localStorage.getItem(key); },
      set: function (key, value) { localStorage.setItem(key, value); }
    },
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { setTimeout(fn, ms); },
    send: sender.send,
    backlog: sender.pending,
    log: function (text) { console.log(text); }
  });
});

Pebble.addEventListener('appmessage', function (e) {
  if (app) app.handle(protocol.decodeWatchMessage(e.payload));
});
