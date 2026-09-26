#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { checkOverrides } from './check.ts';
import { InputError, OverrideCheckError } from './errors.ts';
import { formatHuman, formatJson } from './format.ts';
import { parseManifest } from './manifest.ts';
import { detectNpmLockfile, parseNpmLockfile } from './npm-lockfile.ts';

const USAGE = `Usage:
  overridecheck [dir]
  overridecheck <package.json> <package-lock.json>

Reads package.json + package-lock.json (default: the current directory) and
verifies that every entry in "overrides" actually took effect in the
lockfile — resolving each rule against the real dependency tree instead of
trusting that npm applied it.

Options:
  --json       Print machine-readable JSON instead of the summary.
  -h, --help   Show this help.

Exit codes:
  0   clean — every override took effect, in full, everywhere it applies
  1   findings — an override did not (fully) take effect, "resolutions" is
      present alongside this npm lockfile, or an override references an
      undeclared "$name"
  2   could not analyse — bad usage, unreadable/unsupported input, or a
      range this tool's semver engine does not support (see README)

Supported lockfiles: npm package-lock.json / npm-shrinkwrap.json (v2/v3).
pnpm-lock.yaml and yarn.lock are out of scope — see README "Scope".`;

interface Options {
  positionals: string[];
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const positionals: string[] = [];
  let json = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new InputError(`Unknown flag "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals, json, help };
}

function resolvePaths(positionals: string[], cwd: string): { manifestPath: string; lockPath: string } {
  if (positionals.length > 2) {
    throw new InputError('Too many arguments.');
  }
  if (positionals.length === 2) {
    return { manifestPath: positionals[0]!, lockPath: positionals[1]! };
  }
  const dir = positionals.length === 1 ? positionals[0]! : cwd;
  return { manifestPath: path.join(dir, 'package.json'), lockPath: path.join(dir, 'package-lock.json') };
}

/** Runs the CLI end to end and returns the process exit code, so tests can
 *  call this in-process instead of spawning a subprocess for every case. */
export function run(argv: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (opts.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  try {
    const { manifestPath, lockPath } = resolvePaths(opts.positionals, process.cwd());

    if (!fs.existsSync(manifestPath)) {
      throw new InputError(`Cannot find "${manifestPath}".`);
    }
    if (!fs.existsSync(lockPath)) {
      throw new InputError(`Cannot find "${lockPath}". overridecheck needs a package-lock.json to verify against.`);
    }

    const lockKind = detectNpmLockfile(lockPath);
    if (lockKind === 'unsupported') {
      throw new InputError(
        `"${lockPath}" is not an npm package-lock.json. overridecheck reads npm ` +
          '(package-lock.json / npm-shrinkwrap.json) lockfiles only — pnpm and yarn have their own ' +
          'override semantics that this tool does not verify. See README "Scope".',
      );
    }

    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    const lockText = fs.readFileSync(lockPath, 'utf8');

    const manifest = parseManifest(manifestText, manifestPath);
    const lockfile = parseNpmLockfile(lockText, lockPath);
    const result = checkOverrides(manifest, lockfile);

    stdout(`${opts.json ? formatJson(result) : formatHuman(result)}\n`);
    return result.findings.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof OverrideCheckError) {
      stderr(`${err.message}\n`);
    } else {
      stderr(`${(err as Error).message}\n`);
    }
    return 2;
  }
}

/* node:coverage disable */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(
    process.argv.slice(2),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
}
/* node:coverage enable */
