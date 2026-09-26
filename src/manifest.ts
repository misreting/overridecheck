import { ParseError } from './errors.ts';

export interface RootManifest {
  /** Raw `overrides` field value, exactly as written — `undefined` if absent. */
  overrides: unknown;
  /** Whether a `resolutions` field is present at all (its content is never
   *  read: npm ignores it completely, which is the whole point of flagging it). */
  hasResolutions: boolean;
  /** Raw `resolutions` object, for the enrichment in the finding's message
   *  (best-effort: only plain `"name": "version"` keys are interpreted). */
  resolutions: Record<string, unknown> | undefined;
  /** Look up the version/range this root package.json itself declares for
   *  `name`, across dependencies/devDependencies/optionalDependencies/
   *  peerDependencies, in that priority order — this is what an override's
   *  `"$name"` value resolves against. */
  declaredDependency(name: string): string | undefined;
}

/** Parse the `package.json` fields this tool needs. Everything else in the
 *  file (scripts, exports, etc.) is ignored. */
export function parseManifest(text: string, sourceLabel: string): RootManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`${sourceLabel}: not valid JSON (${(err as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ParseError(`${sourceLabel}: expected a JSON object at the top level.`);
  }

  const depFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

  function declaredDependency(name: string): string | undefined {
    for (const field of depFields) {
      const section = raw[field];
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        const value = (section as Record<string, unknown>)[name];
        if (typeof value === 'string') return value;
      }
    }
    return undefined;
  }

  const resolutions =
    raw.resolutions && typeof raw.resolutions === 'object' && !Array.isArray(raw.resolutions)
      ? (raw.resolutions as Record<string, unknown>)
      : undefined;

  return {
    overrides: raw.overrides,
    hasResolutions: raw.resolutions !== undefined,
    resolutions,
    declaredDependency,
  };
}
