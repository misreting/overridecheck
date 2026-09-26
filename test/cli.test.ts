import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function capture(argv: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = run(
    argv,
    (s) => (out += s),
    (s) => (err += s),
  );
  return { code, out, err };
}

test('CLI: --help exits 0 without touching the filesystem', () => {
  const { code, out } = capture(['--help']);
  assert.equal(code, 0);
  assert.match(out, /Usage:/);
});

test('CLI: unknown flag exits 2', () => {
  const { code, err } = capture(['--nope']);
  assert.equal(code, 2);
  assert.match(err, /Unknown flag/);
});

test('CLI: too many positional arguments exits 2', () => {
  const { code, err } = capture(['a', 'b', 'c']);
  assert.equal(code, 2);
  assert.match(err, /Too many arguments/);
});

test('CLI: missing package.json exits 2 with a clear message', () => {
  const { code, err } = capture([path.join(fixturesDir, 'does-not-exist.json'), path.join(fixturesDir, 'overrides-applied', 'package-lock.json')]);
  assert.equal(code, 2);
  assert.match(err, /Cannot find/);
});

test('CLI: a clean project (real npm fixture) exits 0', () => {
  const dir = path.join(fixturesDir, 'overrides-applied');
  const { code, out } = capture([dir]);
  assert.equal(code, 0);
  assert.match(out, /1 override rule checked {2}\(1 applied, 0 partial, 0 not applied, 0 dead, 0 bad \$ref\)/);
});

test('CLI: a dead override (real npm fixture) exits 1 and prints the DEAD finding', () => {
  const dir = path.join(fixturesDir, 'nested-nonexistent-parent');
  const { code, out } = capture([dir]);
  assert.equal(code, 1);
  assert.match(out, /DEAD\s+nonexistent-parent-pkg/);
});

test('CLI: resolutions field (real npm fixture) exits 1 and prints RESOLUTIONS', () => {
  const dir = path.join(fixturesDir, 'resolutions-ignored');
  const { code, out } = capture([dir]);
  assert.equal(code, 1);
  assert.match(out, /RESOLUTIONS/);
});

test('CLI: --json prints machine-readable output', () => {
  const dir = path.join(fixturesDir, 'nested-nonexistent-parent');
  const { code, out } = capture([dir, '--json']);
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.summary.dead, 1);
  assert.equal(parsed.findings[0].kind, 'dead-no-target');
});

test('CLI: real microsoft/vscode fixture exits 0 clean', () => {
  const dir = path.join(fixturesDir, 'real-vscode');
  const { code, out } = capture([dir]);
  assert.equal(code, 0);
  assert.match(out, /6 override rules checked {2}\(6 applied, 0 partial, 0 not applied, 0 dead, 0 bad \$ref\)/);
});

test('CLI: rejects a pnpm-lock.yaml with a clear scope message, exit 2', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overridecheck-cli-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', overrides: { foo: '1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
  const { code, err } = capture([path.join(dir, 'package.json'), path.join(dir, 'pnpm-lock.yaml')]);
  assert.equal(code, 2);
  assert.match(err, /not an npm package-lock\.json/);
});

test('CLI: two explicit paths (base/head style) work the same as directory mode', () => {
  const dir = path.join(fixturesDir, 'overrides-applied');
  const { code, out } = capture([path.join(dir, 'package.json'), path.join(dir, 'package-lock.json')]);
  assert.equal(code, 0);
  assert.match(out, /1 applied/);
});
