/**
 * Plain-JS checks against the built package and CLI, so they run on every Node
 * version in `engines` — the TypeScript suite needs type stripping and only
 * runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

const { checkOverrides, parseManifest, parseNpmLockfile, satisfies, formatHuman } = await import('../dist/index.js');

test('library: satisfies does range-aware comparison, not string equality', () => {
  assert.equal(satisfies('4.3.0', '^4.0.0'), true);
  assert.equal(satisfies('5.0.0', '^4.0.0'), false);
});

test('library: checkOverrides catches a dead nested override end to end', () => {
  const manifestText = JSON.stringify({
    name: 'demo',
    dependencies: { 'string-width': '4.2.3' },
    overrides: { 'nonexistent-parent-pkg': { 'is-fullwidth-code-point': '999.0.0' } },
  });
  const lockText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { 'string-width': '4.2.3' } },
      'node_modules/string-width': { version: '4.2.3', dependencies: { 'is-fullwidth-code-point': '^3.0.0' } },
      'node_modules/is-fullwidth-code-point': { version: '3.0.0' },
    },
  });
  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);
  assert.equal(result.summary.dead, 1);
  assert.match(formatHuman(result), /DEAD/);
});

test('CLI: runs end to end against a real fixture directory and exits non-zero on a dead override', () => {
  const fixturesDir = path.join(here, 'fixtures');
  const clean = execFileSync('node', [cli, path.join(fixturesDir, 'overrides-applied')], { encoding: 'utf8' });
  assert.match(clean, /1 applied/);

  let threw = false;
  try {
    execFileSync('node', [cli, path.join(fixturesDir, 'nested-nonexistent-parent')], { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 1);
    assert.match(err.stdout, /DEAD\s+nonexistent-parent-pkg/);
  }
  assert.ok(threw, 'a dead override should exit non-zero');
});

test('CLI: rejects a made-up path with exit code 2, not a crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overridecheck-smoke-'));
  let threw = false;
  try {
    execFileSync('node', [cli, root], { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 2);
  }
  assert.ok(threw);
});

test('CLI: --help exits 0 without needing any files', () => {
  const out = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
  assert.match(out, /Usage:/);
});
