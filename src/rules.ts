/**
 * Parses npm's `overrides` field (package.json) into a tree this tool can walk
 * against the lockfile. npm's own syntax (see
 * https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides):
 *
 *   "overrides": {
 *     "foo": "1.0.0",              // force every "foo" anywhere in the tree
 *     "bar": {
 *       ".": "2.0.0",              // force "bar" itself, same as a top-level rule
 *       "foo": "1.0.0",            // force "foo" ONLY when required directly by "bar"
 *       "baz@^1.0.0": "1.0.1"      // nested rule, itself scoped to bar's baz@^1.0.0
 *     },
 *     "quux": "$foo"               // force to whatever the root package.json's own
 *                                  // "foo" dependency/devDependency declares
 *   }
 *
 * The `"name@range"` key form restricts a rule to ancestor occurrences of
 * `name` whose *own* resolved version satisfies `range` — this parser keeps
 * that range as `parentVersionRange` on the node it introduces; `check.ts`
 * applies it against the lockfile.
 */
import { ParseError } from './errors.ts';
import type { RootManifest } from './manifest.ts';

export type SelfTarget =
  | { kind: 'literal'; range: string }
  | { kind: 'dollar-ref'; refName: string; resolved: string }
  | { kind: 'dollar-ref-unresolved'; refName: string };

export interface RuleNode {
  /** Human-readable path for messages, e.g. `bar > baz@^1.0.0`. */
  path: string;
  name: string;
  /** The `@range` suffix on THIS node's own key, if any — restricts which
   *  occurrences of `name` (as found via the parent scope) this node applies
   *  to, by their own resolved version. */
  parentVersionRange?: string;
  /** The version/range this node forces `name` itself to, or `undefined` if
   *  this node exists only to scope its `children` (no "." key, and the raw
   *  value was an object rather than a string). */
  self: SelfTarget | undefined;
  children: RuleNode[];
}

/** Splits an override key into a package name and optional `@range`. Handles
 *  scoped package names (`@scope/name`, `@scope/name@1.2.3`) by only looking
 *  for the range-separator `@` after the first character. */
function splitNameRange(key: string): { name: string; range: string | undefined } {
  const idx = key.indexOf('@', 1);
  if (idx === -1) return { name: key, range: undefined };
  return { name: key.slice(0, idx), range: key.slice(idx + 1) };
}

function resolveTarget(raw: string, manifest: RootManifest): SelfTarget {
  if (raw.startsWith('$')) {
    const refName = raw.slice(1);
    const resolved = manifest.declaredDependency(refName);
    return resolved === undefined ? { kind: 'dollar-ref-unresolved', refName } : { kind: 'dollar-ref', refName, resolved };
  }
  return { kind: 'literal', range: raw };
}

function parseNode(
  name: string,
  parentVersionRange: string | undefined,
  path: string,
  value: unknown,
  manifest: RootManifest,
): RuleNode {
  if (typeof value === 'string') {
    return { path, name, parentVersionRange, self: resolveTarget(value, manifest), children: [] };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    let self: SelfTarget | undefined;
    const children: RuleNode[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '.') {
        if (typeof child !== 'string') {
          throw new ParseError(`overrides entry "${path} > ."  must be a string, got ${typeof child}.`);
        }
        self = resolveTarget(child, manifest);
        continue;
      }
      const { name: childName, range: childRange } = splitNameRange(key);
      children.push(parseNode(childName, childRange, `${path} > ${key}`, child, manifest));
    }
    return { path, name, parentVersionRange, self, children };
  }
  throw new ParseError(`overrides entry "${path}" must be a string or an object, got ${typeof value}.`);
}

/** Parse the whole `overrides` field into one `RuleNode` per top-level entry.
 *  Returns `[]` if `raw` is `undefined` (no overrides declared at all). */
export function parseOverridesRoot(raw: unknown, manifest: RootManifest): RuleNode[] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError('package.json "overrides" must be an object.');
  }
  return Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
    const { name, range } = splitNameRange(key);
    return parseNode(name, range, key, value, manifest);
  });
}
