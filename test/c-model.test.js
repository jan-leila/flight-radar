// Compiles the host C tests in test/c/ against the pure watch modules in src/c/ and runs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hasGcc = spawnSync('gcc', ['--version']).status === 0;
const skip = !hasGcc && 'gcc not found (run inside nix-shell)';

function runC(name, sources) {
  const outDir = path.join(root, 'test', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, name);
  const cc = spawnSync('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-D_POSIX_C_SOURCE=200809L',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-g',
    '-I', path.join(root, 'src/c'), ...sources.map(s => path.join(root, s)), '-o', exe], { encoding: 'utf8' });
  assert.equal(cc.status, 0, 'compile failed:\n' + cc.stderr);
  const run = spawnSync(exe, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
}

test('C radar_model: messages, bitmap, selection (host gcc)', { skip }, () =>
  runC('test_radar_model', ['test/c/test_radar_model.c', 'src/c/radar_model.c']));
test('C radar_label: label placement (host gcc)', { skip }, () =>
  runC('test_radar_label', ['test/c/test_radar_label.c', 'src/c/radar_label.c']));
