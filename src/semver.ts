/**
 * A small, hand-written semver comparator/range engine — this package has zero
 * runtime dependencies, so it does not pull in `semver` (or anything else) to
 * decide whether an installed version satisfies an override's target range.
 *
 * SUPPORTED syntax (this is the syntax that actually shows up in real
 * `overrides` fields — see the README's "Range support" section for why the
 * rest is deliberately out of scope):
 *   - exact versions: "6.0.0", "1.2.3-beta.1"
 *   - partial / X-ranges: "1.2", "1.x", "*", ""
 *   - comparator operators: ">=", "<=", ">", "<", "=" (or no operator, same as "=")
 *   - caret ranges: "^1.2.3", "^0.2.3", "^0.0.3"
 *   - tilde ranges: "~1.2.3", "~1.2", "~1"
 *   - whitespace-separated AND of the above: ">=1.2.0 <2.0.0"
 *   - standard semver 2.0 prerelease precedence and the "a prerelease version
 *     only satisfies a range that explicitly mentions a prerelease with the
 *     same [major, minor, patch]" rule
 *
 * NOT SUPPORTED, and rejected with `UnsupportedRangeError` rather than guessed
 * at: hyphen ranges ("1.2.3 - 2.3.4") and "||" alternatives. Neither showed up
 * in any override this tool was built or tested against (see
 * test/fixtures/real-vscode-overrides), and guessing at a range engine's
 * output is exactly the kind of silent wrongness this tool exists to catch —
 * better to refuse than to misjudge whether an override applied.
 */
import { UnsupportedRangeError } from './errors.ts';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, numeric ones as `number`. Empty for
   *  a release version. */
  prerelease: Array<string | number>;
}

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Strict parse of a full `major.minor.patch[-prerelease][+build]` version.
 *  Build metadata is accepted but discarded (it never affects precedence).
 *  Returns `undefined` for anything else (partial versions, git shas, ranges). */
export function parseVersion(input: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return undefined;
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** semver 2.0 precedence: -1 if a<b, 0 if equal, 1 if a>b. Ignores build metadata. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a is a release, b is a prerelease of the same tuple: a > b
  if (bp.length === 0) return -1;
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1; // fewer fields, all preceding equal: lower precedence
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum) return -1; // numeric identifiers always have lower precedence than alphanumeric
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Wild = 'x';
interface Partial {
  major: number | Wild;
  minor: number | Wild;
  patch: number | Wild;
  prerelease: Array<string | number>;
}

const PARTIAL_RE =
  /^v?(\d+|[xX*]|)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseComponent(s: string | undefined): number | Wild {
  if (s === undefined || s === '' || s === 'x' || s === 'X' || s === '*') return 'x';
  return Number(s);
}

function parsePartial(input: string): Partial | undefined {
  const m = PARTIAL_RE.exec(input.trim());
  if (!m) return undefined;
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: parseComponent(m[1]), minor: parseComponent(m[2]), patch: parseComponent(m[3]), prerelease };
}

interface Bound {
  version: ParsedVersion;
  inclusive: boolean;
}

interface Interval {
  lower?: Bound;
  upper?: Bound;
  /** For the "prerelease only satisfies a range that mentions one at the same
   *  tuple" rule: the exact [major,minor,patch] this token anchored on, when it
   *  had one (i.e. not a bare wildcard token), and whether that anchor itself
   *  carried a prerelease tag. */
  anchor?: { major: number; minor: number; patch: number; hasPrerelease: boolean };
}

function v(major: number, minor: number, patch: number, prerelease: Array<string | number> = []): ParsedVersion {
  return { major, minor, patch, prerelease };
}

/** Parse one whitespace-delimited comparator token into the interval it constrains. */
function parseToken(token: string): Interval {
  const opMatch = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
  const op = opMatch?.[1] ?? '';
  const rest = opMatch?.[2] ?? token;
  const p = parsePartial(rest);
  if (!p) {
    throw new UnsupportedRangeError(`Cannot parse version "${rest}" in range token "${token}".`);
  }
  const wildcard = p.major === 'x';
  const minorWild = p.minor === 'x';
  const patchWild = p.patch === 'x';

  if (op === '' || op === '=') {
    if (wildcard) return {};
    const M = p.major as number;
    if (minorWild) return { lower: { version: v(M, 0, 0), inclusive: true }, upper: { version: v(M + 1, 0, 0), inclusive: false } };
    const m = p.minor as number;
    if (patchWild) return { lower: { version: v(M, m, 0), inclusive: true }, upper: { version: v(M, m + 1, 0), inclusive: false } };
    const pt = p.patch as number;
    const exact = v(M, m, pt, p.prerelease);
    return {
      lower: { version: exact, inclusive: true },
      upper: { version: exact, inclusive: true },
      anchor: { major: M, minor: m, patch: pt, hasPrerelease: p.prerelease.length > 0 },
    };
  }

  if (op === '>=') {
    if (wildcard) return {};
    const M = p.major as number;
    const m = minorWild ? 0 : (p.minor as number);
    const pt = patchWild ? 0 : (p.patch as number);
    const anchorPrerelease = !minorWild && !patchWild ? p.prerelease : [];
    return {
      lower: { version: v(M, m, pt, anchorPrerelease), inclusive: true },
      anchor: !minorWild && !patchWild ? { major: M, minor: m, patch: pt, hasPrerelease: p.prerelease.length > 0 } : undefined,
    };
  }

  if (op === '<=') {
    if (wildcard) return {};
    const M = p.major as number;
    if (minorWild) return { upper: { version: v(M + 1, 0, 0), inclusive: false } };
    const m = p.minor as number;
    if (patchWild) return { upper: { version: v(M, m + 1, 0), inclusive: false } };
    const pt = p.patch as number;
    return {
      upper: { version: v(M, m, pt, p.prerelease), inclusive: true },
      anchor: { major: M, minor: m, patch: pt, hasPrerelease: p.prerelease.length > 0 },
    };
  }

  if (op === '>') {
    if (wildcard) return {};
    const M = p.major as number;
    if (minorWild) return { lower: { version: v(M + 1, 0, 0), inclusive: true } };
    const m = p.minor as number;
    if (patchWild) return { lower: { version: v(M, m + 1, 0), inclusive: true } };
    const pt = p.patch as number;
    return { lower: { version: v(M, m, pt, p.prerelease), inclusive: false } };
  }

  if (op === '<') {
    if (wildcard) return {};
    const M = p.major as number;
    if (minorWild) return { upper: { version: v(M, 0, 0), inclusive: false } };
    const m = p.minor as number;
    if (patchWild) return { upper: { version: v(M, m, 0), inclusive: false } };
    const pt = p.patch as number;
    return { upper: { version: v(M, m, pt, p.prerelease), inclusive: false } };
  }

  if (op === '^') {
    if (wildcard) return {};
    const M = p.major as number;
    if (minorWild) return { lower: { version: v(M, 0, 0), inclusive: true }, upper: { version: v(M + 1, 0, 0), inclusive: false } };
    const m = p.minor as number;
    if (patchWild) {
      return M > 0
        ? { lower: { version: v(M, m, 0), inclusive: true }, upper: { version: v(M + 1, 0, 0), inclusive: false } }
        : { lower: { version: v(M, m, 0), inclusive: true }, upper: { version: v(M, m + 1, 0), inclusive: false } };
    }
    const pt = p.patch as number;
    const lower = v(M, m, pt, p.prerelease);
    const anchor = { major: M, minor: m, patch: pt, hasPrerelease: p.prerelease.length > 0 };
    if (M > 0) return { lower: { version: lower, inclusive: true }, upper: { version: v(M + 1, 0, 0), inclusive: false }, anchor };
    if (m > 0) return { lower: { version: lower, inclusive: true }, upper: { version: v(0, m + 1, 0), inclusive: false }, anchor };
    return { lower: { version: lower, inclusive: true }, upper: { version: v(0, 0, pt + 1), inclusive: false }, anchor };
  }

  // op === '~'
  const M = p.major as number;
  if (wildcard) return {};
  if (minorWild) return { lower: { version: v(M, 0, 0), inclusive: true }, upper: { version: v(M + 1, 0, 0), inclusive: false } };
  const m = p.minor as number;
  const pt = patchWild ? 0 : (p.patch as number);
  const prerelease = patchWild ? [] : p.prerelease;
  return {
    lower: { version: v(M, m, pt, prerelease), inclusive: true },
    upper: { version: v(M, m + 1, 0), inclusive: false },
    anchor: patchWild ? undefined : { major: M, minor: m, patch: pt, hasPrerelease: prerelease.length > 0 },
  };
}

/** Tighter (more restrictive) of two lower bounds: the higher version, or on a
 *  tie the exclusive one (">" excludes more than ">="). */
function tighterLower(a: Bound | undefined, b: Bound | undefined): Bound | undefined {
  if (!a) return b;
  if (!b) return a;
  const c = compareVersions(a.version, b.version);
  if (c !== 0) return c > 0 ? a : b;
  return a.inclusive ? b : a;
}

/** Tighter upper bound: the lower version, or on a tie the exclusive one. */
function tighterUpper(a: Bound | undefined, b: Bound | undefined): Bound | undefined {
  if (!a) return b;
  if (!b) return a;
  const c = compareVersions(a.version, b.version);
  if (c !== 0) return c < 0 ? a : b;
  return a.inclusive ? b : a;
}

/** Whether `range` is well-formed / uses only supported syntax. Throws
 *  `UnsupportedRangeError` for the same reasons `satisfies` would. */
export function validateRange(range: string): void {
  parseRange(range);
}

function parseRange(range: string): { fullWildcard: true } | { fullWildcard: false; interval: Interval } {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'x') {
    return { fullWildcard: true };
  }
  if (trimmed.includes('||')) {
    throw new UnsupportedRangeError(
      `Range "${range}" uses "||" alternatives, which this tool's semver engine does not support (see README "Range support").`,
    );
  }
  if (/\s-\s/.test(trimmed)) {
    throw new UnsupportedRangeError(
      `Range "${range}" uses a hyphen range ("a - b"), which this tool's semver engine does not support (see README "Range support").`,
    );
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let interval: Interval = {};
  for (const token of tokens) {
    const next = parseToken(token);
    interval = {
      lower: tighterLower(interval.lower, next.lower),
      upper: tighterUpper(interval.upper, next.upper),
      anchor: interval.anchor ?? next.anchor,
    };
  }
  return { fullWildcard: false, interval };
}

/**
 * Whether `versionStr` (an exact, installed version — no ranges) satisfies
 * `range`. Throws `UnsupportedRangeError` for a range using unsupported syntax
 * (see module doc), and `ParseError`-worthy `undefined` is never returned:
 * an unparsable *version* (not range) is treated as not satisfying, since a
 * git sha or `file:` version string can never be confirmed to match a
 * declared target.
 */
export function satisfies(versionStr: string, range: string): boolean {
  const version = parseVersion(versionStr);
  const parsed = parseRange(range);
  if (!version) return false;
  if (parsed.fullWildcard) return true;

  const { lower, upper, anchor } = parsed.interval;
  if (lower) {
    const c = compareVersions(version, lower.version);
    if (c < 0 || (c === 0 && !lower.inclusive)) return false;
  }
  if (upper) {
    const c = compareVersions(version, upper.version);
    if (c > 0 || (c === 0 && !upper.inclusive)) return false;
  }

  if (version.prerelease.length > 0) {
    const allowed =
      !!anchor &&
      anchor.hasPrerelease &&
      anchor.major === version.major &&
      anchor.minor === version.minor &&
      anchor.patch === version.patch;
    if (!allowed) return false;
  }

  return true;
}
