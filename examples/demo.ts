/**
 * Demonstrates the three structural findings that don't arise from a small
 * real `npm install` (partial application, a version-scoped parent that never
 * matches, an unresolved "$ref") — the CLI's own dist smoke test already
 * covers the gap report's two real reproductions (resolutions-ignored,
 * nested-nonexistent-parent) plus the real microsoft/vscode fixture; this
 * script covers what's left, with hand-built-but-realistic lockfiles.
 *
 *   node examples/demo.ts
 */
import { checkOverrides, formatHuman, parseManifest, parseNpmLockfile } from '../src/index.ts';

function section(title: string, manifestText: string, lockText: string): void {
  const manifest = parseManifest(manifestText, 'package.json');
  const lockfile = parseNpmLockfile(lockText, 'package-lock.json');
  const result = checkOverrides(manifest, lockfile);
  console.log(`--- ${title} ---`);
  console.log(formatHuman(result));
  console.log();
}

// A global override that only reaches one of two conflicting instances of the
// same dependency — a real, if uncommon, shape (two direct deps needing
// incompatible majors of the same transitive package, so npm can't hoist both).
section(
  'partial application: "shared" forced to ^2.0.0, but only 1 of 2 instances satisfy it',
  JSON.stringify({
    name: 'demo',
    dependencies: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
    overrides: { shared: '^2.0.0' },
  }),
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' } },
      'node_modules/pkg-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/pkg-b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      'node_modules/shared': { version: '2.0.0' },
      'node_modules/pkg-a/node_modules/shared': { version: '1.0.0' },
    },
  }),
);

// microsoft/vscode's actual override shape: a version-scoped parent key. Here
// the parent version is wrong, so the whole rule is structurally dead.
section(
  'dead override: "kerberos@9.9.9" never matches (the tree only has kerberos@2.1.1)',
  JSON.stringify({
    name: 'demo',
    dependencies: { kerberos: '2.1.1' },
    overrides: { 'kerberos@9.9.9': { 'node-addon-api': '99.0.0' } },
  }),
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { kerberos: '2.1.1' } },
      'node_modules/kerberos': { version: '2.1.1', dependencies: { 'node-addon-api': '^7.0.0' } },
      'node_modules/node-addon-api': { version: '7.1.0' },
    },
  }),
);

// A "$name" reference to a dependency the root package.json never declared.
section(
  'misconfigured override: "$doesnotexist" has no matching root dependency',
  JSON.stringify({
    name: 'demo',
    dependencies: { foo: '1.0.0' },
    overrides: { foo: { bar: '$doesnotexist' } },
  }),
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { foo: '1.0.0' } },
      'node_modules/foo': { version: '1.0.0', dependencies: { bar: '^1.0.0' } },
      'node_modules/bar': { version: '1.0.0' },
    },
  }),
);
