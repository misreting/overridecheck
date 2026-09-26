import type { CheckResult, FindingKind } from './check.ts';

const LABELS: Record<FindingKind, string> = {
  'not-applied': 'NOT-APPLIED',
  'partially-applied': 'PARTIAL',
  'dead-no-target': 'DEAD',
  'dead-version-scope': 'DEAD',
  'resolutions-ignored': 'RESOLUTIONS',
  'unresolved-dollar-ref': 'BAD-REF',
};

const LABEL_WIDTH = 12; // widest label, 'NOT-APPLIED', plus one space
const PATH_WIDTH = 28;

export function formatHuman(result: CheckResult): string {
  const { summary, findings } = result;

  if (summary.rulesChecked === 0 && findings.length === 0) {
    return '  no overrides declared in package.json — nothing to verify';
  }

  const lines: string[] = [
    `  ${summary.rulesChecked} override rule${summary.rulesChecked === 1 ? '' : 's'} checked  ` +
      `(${summary.applied} applied, ${summary.partiallyApplied} partial, ${summary.notApplied} not applied, ` +
      `${summary.dead} dead, ${summary.unresolvedRefs} bad $ref)`,
  ];

  if (findings.length > 0) {
    lines.push('');
    for (const f of findings) {
      const label = LABELS[f.kind].padEnd(LABEL_WIDTH);
      const path = f.path.length < PATH_WIDTH ? f.path.padEnd(PATH_WIDTH) : `${f.path} `;
      lines.push(`  ${label}${path}${f.message}`);
    }
  }

  return lines.join('\n');
}

export function formatJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}
