// Enforces the conventions of CONTRACTS.md (top): the phone side is ES5, the modules only know the modules they
// are allowed to, and the two sides of the protocol agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const jsFiles = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => dir + '/' + f);

// Source without comments and string/regex literals, for looking at the syntax only.
function code(file) {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/\/.*$/gm, '')
    .replace(/\/(?![*/\s])(?:[^/\\\n]|\\.)+\/[gimuy]*/g, '0');
}

function requiresOf(file) {
  return [...read(file).replace(/\/\/.*$/gm, '').matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => {
    assert.ok(m[1].startsWith('.'), `${file} requires the package ${m[1]}`);
    return path.relative(ROOT, path.resolve(ROOT, path.dirname(file), m[1])).split(path.sep).join('/') + '.js';
  });
}

test('src/common and src/pkjs are ES5: they run inside PebbleKit JS on every phone', () => {
  for (const file of jsFiles('src/common').concat(jsFiles('src/pkjs'))) {
    const src = code(file);
    for (const [what, re] of [
      ['arrow function', /=>/], ['let', /\blet\s/], ['const', /\bconst\s/], ['class', /\bclass\s/],
      ['template string', /`/], ['spread or rest', /\.\.\./], ['async', /\basync\s/],
      ['for-of', /\bfor\s*\([^)]*\sof\s/], ['Promise', /\bPromise\b/],
      ['Object.assign', /Object\.assign/], ['includes()', /\.includes\(/], ['find()', /\.find(Index)?\(/]
    ]) {
      assert.ok(!re.test(src), `${file} uses ${what}`);
    }
  }
});

test('modules require only what CONTRACTS.md allows', () => {
  const allowed = {
    'src/common/geo.js': [],
    'src/common/planes.js': [],
    'src/common/roads.js': ['src/common/geo.js'],
    'src/common/raster.js': ['src/common/geo.js'],
    'src/common/protocol.js': ['src/common/planes.js'],
    'src/common/session.js': ['src/common/geo.js', 'src/common/roads.js', 'src/common/raster.js', 'src/common/planes.js', 'src/common/protocol.js'],
    'src/pkjs/index.js': ['src/common/protocol.js', 'src/common/session.js'],
    'src/pkjs/fixture-town.js': [],
    'src/pkjs/ui-fixture.js': ['src/common/protocol.js', 'src/common/raster.js', 'src/common/roads.js', 'src/pkjs/fixture-town.js'],
    'src/pkjs/app-fixture.js': ['src/pkjs/fixture-town.js', 'src/pkjs/index.js']
  };
  const files = jsFiles('src/common').concat(jsFiles('src/pkjs'));
  assert.deepEqual(files.sort(), Object.keys(allowed).sort(), 'every module is listed here and in CONTRACTS.md');
  for (const file of files) assert.deepEqual(requiresOf(file).sort(), allowed[file].slice().sort(), file);
});

test('only the composition root touches the phone', () => {
  for (const file of jsFiles('src/common')) {
    const src = code(file);
    for (const name of ['Pebble', 'XMLHttpRequest', 'localStorage', 'navigator', 'console', 'Date', 'setTimeout', 'setInterval']) {
      assert.ok(!new RegExp('(?<![.\\w])' + name + '\\b').test(src), `${file} uses ${name}`);
    }
  }
});

test('the watch modules with logic in them do not need the Pebble SDK', () => {
  for (const file of ['src/c/radar_model.c', 'src/c/radar_model.h', 'src/c/radar_label.c', 'src/c/radar_label.h']) {
    assert.ok(!/#include\s*<pebble\.h>/.test(read(file)), file);
  }
});

test('both sides of the protocol use the same numbers', () => {
  const protocol = require('../src/common/protocol');
  const planes = require('../src/common/planes');
  const header = read('src/c/radar_model.h');
  const c = name => {
    const m = new RegExp('\\b' + name + '\\s*=?\\s*(0x[0-9a-fA-F]+|\\d+)').exec(header);
    assert.ok(m, name + ' not found in radar_model.h');
    return Number(m[1]);
  };
  for (const name of ['PAY_BEGIN', 'PAY_PLANES', 'PAY_STATUS', 'PAY_ERROR', 'PAY_END', 'PAY_BITMAP_BEGIN', 'PAY_BITMAP_CHUNK', 'PAY_TRAIL',
    'SUBCMD_SELECT', 'CMD_HELLO', 'CMD_REFRESH_PLANES', 'CMD_VIEW']) {
    assert.equal(protocol[name], c('RADAR_' + name), name);
  }
  assert.equal(planes.MAX_TRAIL, c('RADAR_MAX_TRAIL'));
  assert.ok(planes.MAX_WIRE_PLANES >= c('RADAR_MAX_PLANES'));
  assert.equal(require('../src/common/raster').COLOR_BACKGROUND, c('RADAR_PIXEL_BACKGROUND'));
  // one chunk and the largest plane list have to fit the watch's inbox
  const inbox = Number(/#define INBOX_SIZE (\d+)/.exec(read('src/c/main.c'))[1]);
  assert.ok(protocol.CHUNK_BYTES + 64 <= inbox);
  assert.ok(2 + planes.MAX_WIRE_PLANES * 36 + planes.MAX_TRAIL * 4 + 64 <= inbox);
});

test('package.json: message keys in protocol order, the location capability, both watches', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.pebble.messageKeys, ['PAYLOAD', 'CMD', 'VAL']);
  assert.ok(pkg.pebble.capabilities.includes('location'), 'the app reads the phone\'s position');
  assert.deepEqual(pkg.pebble.targetPlatforms, ['emery', 'gabbro']);
  assert.match(pkg.version, /^\d+\.\d+\.0$/, 'Pebble only uses major.minor');
  assert.notEqual(pkg.pebble.uuid, 'b90172b6-3609-43ce-ab59-9eb9bde37c73', 'not the original app\'s UUID: both can be installed');
});
