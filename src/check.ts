import { satisfies } from './semver.ts';
import type { RootManifest } from './manifest.ts';
import type { LockNode, NpmLockTree } from './npm-lockfile.ts';
import { parseOverridesRoot, type RuleNode, type SelfTarget } from './rules.ts';

export type FindingKind =
  | 'not-applied'
  | 'partially-applied'
  | 'dead-no-target'
  | 'dead-version-scope'
  | 'resolutions-ignored'
  | 'unresolved-dollar-ref';

export interface Finding {
  kind: FindingKind;
  /** Dotted override path this finding is about, e.g. `bar > foo`, or
   *  `"resolutions"` for the whole-file resolutions flag. */
  path: string;
  name: string;
  /** The version/range this rule wanted, human-readable. Absent for
   *  `resolutions-ignored`. */
  target?: string;
  message: string;
  /** `packages` map keys of the lockfile entries this finding is about. */
  locations?: string[];
}

export interface CheckSummary {
  /** Number of override rules (nodes with a "." / string target) that were
   *  actually evaluated against the lockfile — applied + partiallyApplied +
   *  notApplied + dead + unresolvedRefs. */
  rulesChecked: number;
  applied: number;
  partiallyApplied: number;
  notApplied: number;
  dead: number;
  unresolvedRefs: number;
}

export interface CheckResult {
  summary: CheckSummary;
  findings: Finding[];
}

function targetDisplay(target: SelfTarget): string {
  if (target.kind === 'literal') return `"${target.range}"`;
  if (target.kind === 'dollar-ref') return `"${target.resolved}" (via $${target.refName})`;
  return `$${target.refName} (unresolved)`;
}

function locationList(nodes: LockNode[], cap = 5): string {
  const shown = nodes.slice(0, cap).map((n) => `${n.version} at ${n.key}`);
  const rest = nodes.length > cap ? [`+${nodes.length - cap} more`] : [];
  return [...shown, ...rest].join(', ');
}

function describeResolutions(manifest: RootManifest): Finding {
  const keys = manifest.resolutions ? Object.keys(manifest.resolutions) : [];
  const sample = keys
    .slice(0, 5)
    .map((k) => {
      const v = manifest.resolutions?.[k];
      return typeof v === 'string' ? `${k}@${v}` : k;
    })
    .join(', ');
  const more = keys.length > 5 ? `, +${keys.length - 5} more` : '';
  const list = keys.length > 0 ? ` (${sample}${more})` : '';
  return {
    kind: 'resolutions-ignored',
    path: 'resolutions',
    name: 'resolutions',
    message:
      `package.json has a "resolutions" field${list} — npm never reads this key. It is Yarn's ` +
      'syntax; against an npm package-lock.json it is dead weight that silently does nothing. ' +
      'Use "overrides" instead.',
  };
}

/**
 * Resolve every occurrence of `name` reachable from `scope`:
 *  - `scope === 'root'`: every package in the whole lockfile named `name`
 *    (a top-level override applies "no matter which package depends on it,
 *    or how deep in the tree", per npm's own docs).
 *  - otherwise: `name` as a DIRECT declared dependency of each node in `scope`,
 *    resolved via node_modules nesting rules — a nested override only reaches
 *    its immediate parent's own dependency, not any descendant at any depth.
 */
function instancesOfName(lockfile: NpmLockTree, scope: LockNode[] | 'root', name: string): LockNode[] {
  if (scope === 'root') return lockfile.allByName(name);
  const seen = new Set<string>();
  const out: LockNode[] = [];
  for (const parent of scope) {
    if (!parent.dependencies.has(name)) continue;
    const resolved = lockfile.resolveDependency(parent.key, name);
    if (resolved && !seen.has(resolved.key)) {
      seen.add(resolved.key);
      out.push(resolved);
    }
  }
  return out;
}

/**
 * Verify every override declared in `manifest.overrides` against `lockfile`,
 * plus the `resolutions`-is-dead-weight check. This is the whole tool.
 */
export function checkOverrides(manifest: RootManifest, lockfile: NpmLockTree): CheckResult {
  const findings: Finding[] = [];
  let applied = 0;
  let partiallyApplied = 0;
  let notApplied = 0;
  let dead = 0;
  let unresolvedRefs = 0;

  if (manifest.hasResolutions) {
    findings.push(describeResolutions(manifest));
  }

  function checkSelf(rule: RuleNode, instances: LockNode[]): void {
    const target = rule.self as SelfTarget;
    if (target.kind === 'dollar-ref-unresolved') {
      unresolvedRefs++;
      findings.push({
        kind: 'unresolved-dollar-ref',
        path: rule.path,
        name: rule.name,
        target: `$${target.refName}`,
        message:
          `overrides "${rule.path}" references "$${target.refName}", but the root package.json ` +
          `declares no such dependency — npm cannot resolve this override. Declare a root ` +
          `dependency named "${target.refName}", or use a literal version.`,
      });
      return;
    }

    const range = target.kind === 'literal' ? target.range : target.resolved;
    const failed = instances.filter((n) => !satisfies(n.version, range));

    if (failed.length === 0) {
      applied++;
    } else if (failed.length === instances.length) {
      notApplied++;
      findings.push({
        kind: 'not-applied',
        path: rule.path,
        name: rule.name,
        target: targetDisplay(target),
        message: `wanted ${targetDisplay(target)}, but found ${locationList(failed)} — the override did not take effect.`,
        locations: failed.map((n) => n.key),
      });
    } else {
      partiallyApplied++;
      findings.push({
        kind: 'partially-applied',
        path: rule.path,
        name: rule.name,
        target: targetDisplay(target),
        message:
          `wanted ${targetDisplay(target)} — applied at ${instances.length - failed.length} of ` +
          `${instances.length} location(s); NOT applied at ${locationList(failed)}. A partial ` +
          'application can be worse than none: some code paths get the patched version, others do not.',
        locations: failed.map((n) => n.key),
      });
    }
  }

  function walk(rule: RuleNode, parentScope: LockNode[] | 'root'): void {
    const raw = instancesOfName(lockfile, parentScope, rule.name);

    if (raw.length === 0) {
      dead++;
      findings.push({
        kind: 'dead-no-target',
        path: rule.path,
        name: rule.name,
        target: rule.self ? targetDisplay(rule.self) : undefined,
        message:
          parentScope === 'root'
            ? `"${rule.name}" is not a package anywhere in this lockfile — this override can never take effect.`
            : `"${rule.name}" is never a direct dependency of anything matched by the parent rule — this override can never take effect.`,
      });
      return;
    }

    let scoped = raw;
    if (rule.parentVersionRange !== undefined) {
      scoped = raw.filter((n) => satisfies(n.version, rule.parentVersionRange as string));
      if (scoped.length === 0) {
        dead++;
        const found = [...new Set(raw.map((n) => n.version))].join(', ');
        findings.push({
          kind: 'dead-version-scope',
          path: rule.path,
          name: rule.name,
          target: rule.self ? targetDisplay(rule.self) : undefined,
          message:
            `"${rule.name}@${rule.parentVersionRange}" never matches — the tree only has ` +
            `${rule.name}@${found}, so this override can never take effect.`,
          locations: raw.map((n) => n.key),
        });
        return;
      }
    }

    if (rule.self !== undefined) checkSelf(rule, scoped);
    for (const child of rule.children) walk(child, scoped);
  }

  for (const rule of parseOverridesRoot(manifest.overrides, manifest)) {
    walk(rule, 'root');
  }

  return {
    summary: {
      rulesChecked: applied + partiallyApplied + notApplied + dead + unresolvedRefs,
      applied,
      partiallyApplied,
      notApplied,
      dead,
      unresolvedRefs,
    },
    findings,
  };
}
