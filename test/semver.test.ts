import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsupportedRangeError } from '../src/errors.ts';
import { compareVersions, parseVersion, satisfies } from '../src/semver.ts';

test('parseVersion: exact versions, prerelease, build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, prerelease: ['beta', 1] });
  assert.deepEqual(parseVersion('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('1.2.3-rc.1+build.5'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] });
  assert.equal(parseVersion('1.2'), undefined);
  assert.equal(parseVersion('not-a-version'), undefined);
  assert.equal(parseVersion('git+ssh://example.com/x.git'), undefined);
});

test('compareVersions: numeric precedence', () => {
  assert.equal(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.4')!), -1);
  assert.equal(compareVersions(parseVersion('1.3.0')!, parseVersion('1.2.9')!), 1);
  assert.equal(compareVersions(parseVersion('2.0.0')!, parseVersion('1.9.9')!), 1);
  assert.equal(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.3')!), 0);
});

test('compareVersions: prerelease has lower precedence than release of the same tuple', () => {
  assert.equal(compareVersions(parseVersion('1.2.3-alpha')!, parseVersion('1.2.3')!), -1);
  assert.equal(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.3-alpha')!), 1);
});

test('compareVersions: prerelease identifier comparison rules (semver 2.0 §11)', () => {
  // numeric identifiers compare numerically and always sort below alphanumeric ones
  assert.equal(compareVersions(parseVersion('1.0.0-alpha')!, parseVersion('1.0.0-alpha.1')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-alpha.1')!, parseVersion('1.0.0-alpha.beta')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-alpha.beta')!, parseVersion('1.0.0-beta')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-beta')!, parseVersion('1.0.0-beta.2')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-beta.2')!, parseVersion('1.0.0-beta.11')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-beta.11')!, parseVersion('1.0.0-rc.1')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('1.0.0')!), -1);
  assert.equal(compareVersions(parseVersion('1.0.0-9')!, parseVersion('1.0.0-10')!), -1); // numeric, not lexicographic
  assert.equal(compareVersions(parseVersion('1.0.0-9')!, parseVersion('1.0.0-abc')!), -1); // numeric < alphanumeric
});

test('satisfies: exact version target', () => {
  assert.equal(satisfies('6.0.0', '6.0.0'), true);
  assert.equal(satisfies('6.0.1', '6.0.0'), false);
  assert.equal(satisfies('7.0.0', '6.0.0'), false);
});

test('satisfies: caret ranges — the exact case the gap report is built on', () => {
  // is-number 6.0.0 forced by "overrides": exact match
  assert.equal(satisfies('6.0.0', '6.0.0'), true);
  // ansi-styles ^4.0.0 resolving to 4.3.0 in a real npm install (see
  // test/fixtures/range-target-applied) — string equality would wrongly say "no"
  assert.equal(satisfies('4.3.0', '^4.0.0'), true);
  assert.equal(satisfies('5.0.0', '^4.0.0'), false);
  assert.equal(satisfies('3.9.9', '^4.0.0'), false);
});

test('satisfies: caret zero-major special cases', () => {
  assert.equal(satisfies('0.2.3', '^0.2.3'), true);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('0.1.0', '^0.0.x'), false);
  assert.equal(satisfies('0.0.9', '^0.0.x'), true);
});

test('satisfies: tilde ranges', () => {
  assert.equal(satisfies('1.2.3', '~1.2.3'), true);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.2.0', '~1.2'), true);
  assert.equal(satisfies('1.9.0', '~1'), true);
  assert.equal(satisfies('2.0.0', '~1'), false);
});

test('satisfies: X-ranges and full wildcards', () => {
  assert.equal(satisfies('1.2.3', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.9.9', '1.x'), true);
  assert.equal(satisfies('2.0.0', '1.x'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('9.9.9', ''), true);
});

test('satisfies: comparator operators, including partial-version widening', () => {
  assert.equal(satisfies('1.2.5', '>=1.2.0'), true);
  assert.equal(satisfies('1.1.9', '>=1.2.0'), false);
  assert.equal(satisfies('1.3.0', '>=1.2'), true); // >=1.2 => >=1.2.0
  assert.equal(satisfies('1.1.9', '>=1.2'), false);
  assert.equal(satisfies('1.2.9', '<=1.2'), true); // <=1.2 => <1.3.0
  assert.equal(satisfies('1.3.0', '<=1.2'), false);
  assert.equal(satisfies('1.3.0', '>1.2'), true); // >1.2 => >=1.3.0
  assert.equal(satisfies('1.2.9', '>1.2'), false);
  assert.equal(satisfies('1.1.9', '<1.2'), true); // <1.2 => <1.2.0
  assert.equal(satisfies('1.2.0', '<1.2'), false);
  assert.equal(satisfies('2.0.0', '>=1'), true); // >=1 => >=1.0.0
  assert.equal(satisfies('0.9.0', '>=1'), false);
});

test('satisfies: whitespace-separated AND of comparators', () => {
  assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
  assert.equal(satisfies('1.1.9', '>=1.2.0 <2.0.0'), false);
});

test('satisfies: prerelease versions only satisfy a range with an explicit same-tuple prerelease', () => {
  assert.equal(satisfies('1.2.3-beta', '1.2.3-beta'), true);
  assert.equal(satisfies('1.2.3-beta.5', '>=1.2.3-alpha <1.2.3'), true);
  assert.equal(satisfies('1.2.3-beta', '^1.2.3'), false); // ^1.2.3's anchor has no prerelease tag
  assert.equal(satisfies('1.2.4-beta', '^1.2.3'), false); // different tuple entirely
  assert.equal(satisfies('1.2.3', '^1.2.3'), true); // release version, unaffected by the gating rule
  assert.equal(satisfies('1.2.3-beta', '*'), true); // full wildcard always allows prerelease
});

test('satisfies: an unparsable installed version never satisfies anything', () => {
  assert.equal(satisfies('file:../local-pkg', '^1.0.0'), false);
  assert.equal(satisfies('workspace:*', '1.2.3'), false);
});

test('satisfies: unsupported range syntax throws UnsupportedRangeError rather than guessing', () => {
  assert.throws(() => satisfies('1.2.3', '1.2.3 || 2.0.0'), UnsupportedRangeError);
  assert.throws(() => satisfies('1.2.3', '1.0.0 - 2.0.0'), UnsupportedRangeError);
  assert.throws(() => satisfies('1.2.3', 'not-a-range'), UnsupportedRangeError);
});
