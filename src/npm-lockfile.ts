/**
 * A minimal npm `package-lock.json` (v2/v3) reader, scoped to exactly what
 * override verification needs: the resolved tree (`packages`), each package's
 * own declared dependencies (so we can walk "is X a dependency of Y"), and
 * node_modules-style resolution (so "the nearest node_modules/X above this
 * package" matches what npm itself would have installed).
 *
 * This is deliberately its own small parser rather than a shared one with
 * `lockfile-review` (a sibling package in this same repo) — the two tools
 * read different fields for different purposes, and duplicating the ~60 lines
 * of node_modules-resolution logic is cheaper than a cross-package dependency
 * for a zero-runtime-dependency CLI.
 */
import { ParseError, UnsupportedLockfileError } from './errors.ts';

export interface LockNode {
  /** The `packages` map key, e.g. `"node_modules/a/node_modules/foo"`. */
  key: string;
  name: string;
  version: string;
  /** This package's own declared `dependencies` + `optionalDependencies`
   *  (name -> version spec, exactly as written in *its* package.json). Not the
   *  resolved versions — those are looked up via `resolveDependency`. */
  dependencies: Map<string, string>;
}

export interface NpmLockTree {
  /** Every installed package, keyed by its `packages` map key. Excludes the
   *  project root itself (key `""`). */
  nodes: Map<string, LockNode>;
  /** The project root's own declared dependencies (dependencies +
   *  devDependencies + optionalDependencies — everything `npm install` at the
   *  root would actually try to satisfy). */
  rootDependencies: Map<string, string>;
  /** Resolve a dependency named `name` required by the package at `fromKey`
   *  (`""` for the root) to the concrete node that satisfies it, following
   *  node_modules nesting rules: nearest ancestor's `node_modules/<name>` wins. */
  resolveDependency(fromKey: string, name: string): LockNode | undefined;
  /** Every installed node with this package name, in `packages` map order. */
  allByName(name: string): LockNode[];
}

interface RawPackageEntry {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface RawNpmLockfile {
  lockfileVersion?: number;
  packages?: Record<string, RawPackageEntry>;
}

function nameFromKey(key: string, raw: RawPackageEntry): string {
  if (raw.name) return raw.name;
  const idx = key.lastIndexOf('node_modules/');
  return idx === -1 ? key : key.slice(idx + 'node_modules/'.length);
}

/** Candidate `packages` keys where a dependency named `name`, required by the
 *  package at `fromKey`, would live — nearest first, mirroring node_modules
 *  resolution (a package's own nested node_modules, then each ancestor's). */
function candidateKeys(fromKey: string, name: string): string[] {
  if (fromKey === '') return [`node_modules/${name}`];
  const keys: string[] = [];
  let rest = fromKey;
  for (;;) {
    keys.push(`${rest}/node_modules/${name}`);
    const idx = rest.lastIndexOf('/node_modules/');
    if (idx === -1) break;
    rest = rest.slice(0, idx);
  }
  keys.push(`node_modules/${name}`);
  return keys;
}

function depsOf(raw: RawPackageEntry, isRoot: boolean): Map<string, string> {
  const merged = new Map<string, string>();
  for (const [n, spec] of Object.entries(raw.dependencies ?? {})) merged.set(n, spec);
  for (const [n, spec] of Object.entries(raw.optionalDependencies ?? {})) merged.set(n, spec);
  if (isRoot) {
    for (const [n, spec] of Object.entries(raw.devDependencies ?? {})) merged.set(n, spec);
  }
  return merged;
}

/** Parse a `package-lock.json` (v2 or v3) into an `NpmLockTree`. */
export function parseNpmLockfile(text: string, sourceLabel: string): NpmLockTree {
  let raw: RawNpmLockfile;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`${sourceLabel}: not valid JSON (${(err as Error).message})`);
  }

  if (!raw.packages) {
    throw new UnsupportedLockfileError(
      `${sourceLabel}: no "packages" map found. lockfileVersion ${raw.lockfileVersion ?? '1 (or unset)'} ` +
        'predates the packages map this tool relies on — regenerate the lockfile with npm >= 7. ' +
        'overridecheck reads npm package-lock.json v2/v3 only; see README "Scope".',
    );
  }

  const nodes = new Map<string, LockNode>();
  const rawByKey = new Map<string, RawPackageEntry>();
  const byName = new Map<string, LockNode[]>();

  for (const [key, entry] of Object.entries(raw.packages)) {
    rawByKey.set(key, entry);
    if (key === '') continue;
    const node: LockNode = {
      key,
      name: nameFromKey(key, entry),
      version: entry.version ?? '',
      dependencies: depsOf(entry, false),
    };
    nodes.set(key, node);
    const list = byName.get(node.name);
    if (list) list.push(node);
    else byName.set(node.name, [node]);
  }

  const rootEntry = rawByKey.get('') ?? {};
  const rootDependencies = depsOf(rootEntry, true);

  function resolveDependency(fromKey: string, name: string): LockNode | undefined {
    for (const candidate of candidateKeys(fromKey, name)) {
      const node = nodes.get(candidate);
      if (node) return node;
    }
    return undefined;
  }

  return {
    nodes,
    rootDependencies,
    resolveDependency,
    allByName: (name: string) => byName.get(name) ?? [],
  };
}

/** Filename-based sniff: is this an npm lockfile, a lockfile from an
 *  unsupported ecosystem, or unrecognised? See README "Scope". */
export function detectNpmLockfile(filePath: string): 'npm' | 'unsupported' | undefined {
  const base = filePath.split('/').pop() ?? filePath;
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'npm';
  if (base === 'pnpm-lock.yaml' || base === 'yarn.lock') return 'unsupported';
  return undefined;
}
