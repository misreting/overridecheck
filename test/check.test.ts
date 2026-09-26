/**
 * Most of these tests read REAL lockfiles from `test/fixtures/`, produced by
 * running actual `npm install --package-lock-only` against the public
 * registry (see the README's "Evidence" section for the exact commands and
 * their real output). A handful of scenarios this tool needs to handle —
 * partial application, a version-scoped parent that never matches, an
 * unresolved "$ref" — don't arise from a small real install, so those are
 * hand-built lockfile JSON, clearly marked as such below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkOverrides } from '../src/check.ts';
import { ParseError } from '../src/errors.ts';
import { parseManifest } from '../src/manifest.ts';
import { detectNpmLockfile, parseNpmLockfile } from '../src/npm-lockfile.ts';
import { parseOverridesRoot } from '../src/rules.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

function loadFixture(name: string) {
  const dir = path.join(fixturesDir, name);
  const manifest = parseManifest(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), 'package.json');
  const lockfile = parseNpmLockfile(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), 'package-lock.json');
  return checkOverrides(manifest, lockfile);
}

// --- Real npm installs: the gap report's own reproduction --------------------

test('REAL FIXTURE: overrides-applied — is-number forced to 6.0.0, npm applied it', () => {
  const result = loadFixture('overrides-applied');
  assert.equal(result.summary.rulesChecked, 1);
  assert.equal(result.summary.applied, 1);
  assert.equal(result.findings.length, 0);
});

test('REAL FIXTURE: resolutions-ignored — "resolutions" is flagged as dead weight against npm', () => {
  const result = loadFixture('resolutions-ignored');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'resolutions-ignored');
  assert.match(result.findings[0]!.message, /npm never reads this key/);
  assert.match(result.findings[0]!.message, /is-number@6\.0\.0/);
});

test('REAL FIXTURE: nested-nonexistent-parent — dead override, parent key matches nothing', () => {
  const result = loadFixture('nested-nonexistent-parent');
  assert.equal(result.summary.dead, 1);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0]!;
  assert.equal(f.kind, 'dead-no-target');
  assert.equal(f.path, 'nonexistent-parent-pkg');
  assert.match(f.message, /never a package|not a package anywhere/);
});

test('REAL FIXTURE: nested-real-parent-applied — nested "." -free rule scoped to a real parent', () => {
  const result = loadFixture('nested-real-parent-applied');
  assert.equal(result.summary.rulesChecked, 1);
  assert.equal(result.summary.applied, 1);
  assert.equal(result.findings.length, 0);
});

test('REAL FIXTURE: dollar-ref-applied — "$is-number" resolves against the root dependency', () => {
  const result = loadFixture('dollar-ref-applied');
  assert.equal(result.summary.applied, 1);
  assert.equal(result.findings.length, 0);
});

test('REAL FIXTURE: range-target-applied — "^4.0.0" satisfied by the real 4.3.0 npm installed', () => {
  const result = loadFixture('range-target-applied');
  assert.equal(result.summary.applied, 1);
  assert.equal(result.findings.length, 0);
});

test('REAL-WORLD PROJECT: microsoft/vscode package.json + package-lock.json — all 6 overrides clean', () => {
  const result = loadFixture('real-vscode');
  assert.equal(result.summary.rulesChecked, 6);
  assert.equal(result.summary.applied, 6);
  assert.equal(result.findings.length, 0, JSON.stringify(result.findings, null, 2));
});

// --- Hand-built lockfiles for scenarios a small real install won't produce --

function syntheticLock(
  rootDeps: Record<string, string>,
  packages: Record<string, { version: string; dependencies?: Record<string, string> }>,
): string {
  const entries: Record<string, unknown> = { '': { name: 'demo', version: '1.0.0', dependencies: rootDeps } };
  for (const [key, entry] of Object.entries(packages)) {
    entries[key] = { version: entry.version, ...(entry.dependencies ? { dependencies: entry.dependencies } : {}) };
  }
  return JSON.stringify({ lockfileVersion: 3, requires: true, packages: entries });
}

test('SYNTHETIC: partially-applied — a global override satisfied at one location but not another', () => {
  // Two direct dependencies each need a different major of "shared"; npm can't
  // hoist both, so the lockfile legitimately has two "shared" entries at two
  // different versions. A global (unscoped) override is supposed to reach
  // every one of them.
  const lockText = syntheticLock(
    { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
    {
      'node_modules/pkg-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/pkg-b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      'node_modules/shared': { version: '2.0.0' }, // satisfies pkg-b directly, hoisted
      'node_modules/pkg-a/node_modules/shared': { version: '1.0.0' }, // pkg-a's own, nested
    },
  );
  const manifestText = JSON.stringify({
    name: 'demo',
    dependencies: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
    overrides: { shared: '^2.0.0' },
  });

  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);

  assert.equal(result.summary.partiallyApplied, 1);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0]!;
  assert.equal(f.kind, 'partially-applied');
  assert.match(f.message, /applied at 1 of 2 location/);
  assert.deepEqual(f.locations, ['node_modules/pkg-a/node_modules/shared']);
});

test('SYNTHETIC: dead-version-scope — a version-scoped parent key ("pkg@range") that never matches', () => {
  const lockText = syntheticLock(
    { kerberos: '2.1.1' },
    {
      'node_modules/kerberos': { version: '2.1.1', dependencies: { 'node-addon-api': '^7.0.0' } },
      'node_modules/node-addon-api': { version: '7.1.0' },
    },
  );
  const manifestText = JSON.stringify({
    name: 'demo',
    dependencies: { kerberos: '2.1.1' },
    // kerberos is only ever 2.1.1 in this tree, never 9.9.9 — the whole rule is dead.
    overrides: { 'kerberos@9.9.9': { 'node-addon-api': '99.0.0' } },
  });

  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);

  assert.equal(result.summary.dead, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'dead-version-scope');
  assert.match(result.findings[0]!.message, /kerberos@9\.9\.9/);
  assert.match(result.findings[0]!.message, /kerberos@2\.1\.1/);
});

test('SYNTHETIC: unresolved-dollar-ref — "$name" with no matching root dependency', () => {
  const lockText = syntheticLock(
    { foo: '1.0.0' },
    {
      'node_modules/foo': { version: '1.0.0', dependencies: { bar: '^1.0.0' } },
      'node_modules/bar': { version: '1.0.0' },
    },
  );
  const manifestText = JSON.stringify({
    name: 'demo',
    dependencies: { foo: '1.0.0' },
    overrides: { foo: { bar: '$doesnotexist' } },
  });

  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);

  assert.equal(result.summary.unresolvedRefs, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'unresolved-dollar-ref');
  assert.match(result.findings[0]!.message, /\$doesnotexist/);
});

test('SYNTHETIC: not-applied — a global override with no matching location at all in the tree fails to apply', () => {
  const lockText = syntheticLock({ foo: '1.0.0' }, { 'node_modules/foo': { version: '2.0.0' } });
  const manifestText = JSON.stringify({
    name: 'demo',
    dependencies: { foo: '1.0.0' },
    overrides: { foo: '1.0.0' },
  });
  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);

  assert.equal(result.summary.notApplied, 1);
  assert.equal(result.findings[0]!.kind, 'not-applied');
  assert.match(result.findings[0]!.message, /wanted "1\.0\.0"/);
  assert.match(result.findings[0]!.message, /2\.0\.0/);
});

test('no overrides and no resolutions: clean, empty report', () => {
  const manifest = parseManifest(JSON.stringify({ name: 'demo', dependencies: {} }), 'package.json');
  const lockfile = parseNpmLockfile(
    JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo' } } }),
    'package-lock.json',
  );
  const result = checkOverrides(manifest, lockfile);
  assert.equal(result.summary.rulesChecked, 0);
  assert.equal(result.findings.length, 0);
});

// --- Parsing edge cases ------------------------------------------------------

test('parseOverridesRoot: "." key must be a string', () => {
  const manifest = parseManifest(JSON.stringify({ name: 'demo', overrides: { foo: { '.': { nope: true } } } }), 'p');
  assert.throws(() => parseOverridesRoot(manifest.overrides, manifest), ParseError);
});

test('parseOverridesRoot: scoped package names with a version suffix parse correctly', () => {
  const manifest = parseManifest(
    JSON.stringify({ name: 'demo', overrides: { '@types/node@^20.0.0': { '@types/react': '18.0.0' } } }),
    'p',
  );
  const rules = parseOverridesRoot(manifest.overrides, manifest);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.name, '@types/node');
  assert.equal(rules[0]!.parentVersionRange, '^20.0.0');
  assert.equal(rules[0]!.children[0]!.name, '@types/react');
});

test('detectNpmLockfile: filenames', () => {
  assert.equal(detectNpmLockfile('package-lock.json'), 'npm');
  assert.equal(detectNpmLockfile('npm-shrinkwrap.json'), 'npm');
  assert.equal(detectNpmLockfile('pnpm-lock.yaml'), 'unsupported');
  assert.equal(detectNpmLockfile('yarn.lock'), 'unsupported');
  assert.equal(detectNpmLockfile('renamed.json'), undefined);
});
