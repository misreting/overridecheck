# overridecheck

Verifies that npm's `overrides` field in `package.json` actually took effect
in `package-lock.json` — instead of trusting that it did.

```
$ overridecheck path/to/project-with-a-dead-override
  1 override rule checked  (0 applied, 0 partial, 0 not applied, 1 dead, 0 bad $ref)

  DEAD        nonexistent-parent-pkg      "nonexistent-parent-pkg" is not a package anywhere in this lockfile — this override can never take effect.
$ echo $?
1
```

That's real `overridecheck` output against a real `npm install` — see
"Evidence" below for every command.

## The problem

`overrides` is the standard way teams force a patched version of a
known-vulnerable transitive dependency — the CVE-remediation move: "one of my
dependencies pulls in `is-number@7.0.0`, which has a problem, so I pin it to
`6.0.0` everywhere." Everyone assumes that once it's in `package.json`, it's
in effect.

It silently does nothing in at least two common situations, verified against
npm 11.19.0:

1. **`resolutions` instead of `overrides`.** `resolutions` is Yarn's field.
   npm has never read it, at any version. A project migrated from Yarn, or a
   dependency added by someone who copy-pasted a Yarn-flavored README, ends up
   with a `resolutions` block that npm silently ignores — install still
   succeeds, exit code 0, zero warnings.
2. **A nested override whose parent key doesn't exist in the tree.** npm's
   nested-override syntax (`"overrides": {"parent": {"child": "1.2.3"}}`)
   scopes the rule to occurrences of `child` that are direct dependencies of
   `parent`. Typo the parent's name, or have it drop out of the tree in a
   later dependency bump, and the override rule becomes permanently inert —
   again, install succeeds, exit code 0, zero warnings.

Both failures mean a team can look at their own `package.json`, see the
override they added for a CVE, and be completely wrong about whether it's
doing anything. There is nothing in `npm install`'s output that tells you.
This repo's sibling package, [`lockfile-review`](../lockfile-review), reads
exactly this same file — but it diffs *changes* between two lockfiles (added
packages, gained install scripts, major bumps); it has no concept of "does the
currently-declared overrides field match the currently-installed tree," which
is a single-file, single-point-in-time question this tool answers instead.

### Why "just read the lockfile" doesn't work

A `package-lock.json` doesn't record which packages were affected by
`overrides` at all — not `true`, not `false`, nothing. This was checked
against npm 11.19.0's own source before writing a line of this tool: the
in-memory dependency graph (`@npmcli/arborist`) computes an `overridden`
property on each node while it resolves the tree, but `lib/shrinkwrap.js`
never serializes it into the file it writes. Confirmed directly:

```sh
$ npm install --package-lock-only   # is-number forced to 6.0.0 via overrides
$ grep -A3 '"node_modules/is-number"' package-lock.json
    "node_modules/is-number": {
      "version": "6.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
      "integrity": "sha512-...",
```

No `"overridden"` field, no comment, nothing to distinguish this from a
package that happened to resolve to `6.0.0` on its own. The only way to know
an override took effect is to independently walk the dependency graph and
check — which is what this tool does.

## Install

```sh
npm install -g overridecheck
# or, without installing:
npx overridecheck
```

Node >= 20.6. No runtime dependencies.

## Use

```sh
# Defaults to ./package.json + ./package-lock.json
overridecheck

# A specific project directory
overridecheck path/to/project

# Two explicit paths
overridecheck path/to/package.json path/to/package-lock.json

# CI
overridecheck || exit 1   # already exits 1 on any finding — see "Exit codes"
overridecheck --json > report.json
```

## Options

| Flag | What it does |
| --- | --- |
| `--json` | Print the full result as JSON instead of the summary. |
| `--help` | Print usage. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean — every declared override took effect, in full, everywhere it applies. |
| `1` | At least one finding: an override didn't (fully) apply, `resolutions` is present, or a `"$name"` reference is unresolved. |
| `2` | Could not analyse — bad usage, missing/unreadable files, an unsupported lockfile (pnpm/yarn), or a range this tool's semver engine doesn't support. |

Unlike `lockfile-review` (advisory by default, opt into `--fail-on`), this
tool **fails your build by default**. The two are answering different
questions: "here's what changed, some of it might be worth a look" is
advisory; "the security control you declared did not apply" is not — a team
that added an override for a CVE and silently didn't get it is exactly the
failure mode this tool exists to catch, and a clean exit code that means
"nothing to look at" would recreate it.

## What each finding means

| Finding | What it means |
| --- | --- |
| `NOT-APPLIED` | Every location the rule should reach has a version that doesn't satisfy the target. The override did nothing, anywhere. |
| `PARTIAL` | Some locations satisfy the target, others don't. **Reported distinctly, and arguably worse than `NOT-APPLIED`**: a team that sees "the override worked" (because it checked one place) can ship code where some transitive path still carries the vulnerable version. |
| `DEAD` | The rule (or the parent segment of a nested rule) matches no package in the tree at all, or a version-scoped parent key (`"pkg@1.2.3"`) never matches any installed version of that parent — the rule is structurally incapable of ever applying, independent of what version anything resolves to. |
| `RESOLUTIONS` | `package.json` has a `resolutions` field. Against an npm lockfile this is always dead weight — see "The problem" above. |
| `BAD-REF` | An override value is `"$name"`, but the root `package.json` declares no dependency named `name`. npm cannot resolve this; the override does not do what its author intended. |

Rules that resolve cleanly are counted in the summary line but don't get
their own line — same reasoning as `lockfile-review`: the interesting output
is what's wrong, not a restatement of what's fine.

## How verification works

For each entry in `overrides`:

1. **Resolve scope.** A top-level string rule (`"foo": "1.0.0"`) applies to
   every occurrence of `foo` anywhere in the lockfile — that's npm's own
   documented behavior ("no matter which package depends on it, or how deep in
   the tree"). A nested rule (`"parent": {"child": "1.0.0"}`) applies only to
   occurrences of `child` that are a **direct** declared dependency of an
   occurrence of `parent` already in scope — chains nest arbitrarily deep
   (`"a": {"b": {"c": "..."}}` requires the direct edges `a -> b -> c`).
2. **Apply the `"pkg@range"` parent restriction**, if the key has one: among
   the occurrences of the parent name found in step 1, keep only the ones
   whose own installed version satisfies `range`. If none do (or the parent
   didn't appear at all), the rule is `DEAD` and nothing under it is checked
   further — one finding, not one per descendant.
3. **Resolve `"$name"`** against the root `package.json`'s own
   `dependencies` / `devDependencies` / `optionalDependencies` /
   `peerDependencies` (in that priority order). Unresolvable -> `BAD-REF`.
4. **Check every remaining occurrence** against the target with range-aware
   semver (`^4.0.0` is satisfied by `4.3.0` — see below), and classify the
   rule as applied / `PARTIAL` / `NOT-APPLIED` based on how many of them match.

## Range support

This package has zero runtime dependencies, so its semver range engine
(`src/semver.ts`) is hand-written, not `node-semver`. It supports:

- exact versions (`6.0.0`) and prerelease (`1.2.3-beta.1`)
- partial / X-ranges (`1.2`, `1.x`, `*`, `""`)
- comparator operators `>=`, `<=`, `>`, `<`, `=` (or no operator), including
  the X-range widening npm itself applies (`>1.2` means `>=1.3.0`, `<=1.2`
  means `<1.3.0`, etc.)
- caret (`^1.2.3`, `^0.2.3`, `^0.0.3`) and tilde (`~1.2.3`, `~1.2`, `~1`)
  ranges, including the zero-major special cases
- whitespace-separated AND (`>=1.2.0 <2.0.0`)
- semver 2.0 prerelease precedence, including the rule that a prerelease
  version only satisfies a range that explicitly carries a prerelease tag at
  the same `[major, minor, patch]`

**Not supported, and rejected with a clear error (exit code 2) rather than
guessed at:** hyphen ranges (`"1.2.3 - 2.3.4"`) and `"||"` alternatives.
Neither showed up in any override this tool was built or tested against,
including a real-world project's full `overrides` block (see "Evidence"
below) — and silently misjudging a range is exactly the kind of wrongness
this tool exists to catch. `test/semver.test.ts` exercises every rule above
directly, including the prerelease-gating edge cases.

## Scope

**npm + `package-lock.json` (v2/v3) only.** pnpm and yarn have their own
override syntax (`pnpm.overrides`, yarn's `resolutions`) and their own lockfile
formats — neither was verified while building this tool, so neither is
supported. Pointing this tool at a `pnpm-lock.yaml` or `yarn.lock` fails
loudly with a clear message and exit code 2, rather than silently
misinterpreting a format it wasn't built against:

```sh
$ overridecheck path/to/pnpm-project
"path/to/pnpm-project/pnpm-lock.yaml" is not an npm package-lock.json. overridecheck reads npm
(package-lock.json / npm-shrinkwrap.json) lockfiles only — pnpm and yarn have their own override
semantics that this tool does not verify. See README "Scope".
```

`lockfileVersion` 1 (npm < 7, no `packages` map) is also refused with a clear
message rather than parsed approximately.

## Evidence

Every fixture below is a **real** lockfile: `npm install --package-lock-only`
(npm 11.19.0) against the public registry, checked into
`test/fixtures/*/package-lock.json`. Nothing here is hand-typed JSON standing
in for what npm would produce, except where explicitly marked SYNTHETIC below
(a handful of structural cases — partial application across two conflicting
peer instances, a version-scoped parent key that never matches, an
unresolved `$ref` — that don't arise from a small real install; those are
covered by unit tests and `examples/demo.ts` instead, and marked as such in
the test file).

**The gap report's own reproduction** (`is-number` forced via `to-regex-range@5.0.1`):

```sh
$ mkdir overrides-applied && cd overrides-applied
$ cat package.json
{ "dependencies": { "to-regex-range": "5.0.1" }, "overrides": { "is-number": "6.0.0" } }
$ npm install --package-lock-only
$ overridecheck .
  1 override rule checked  (1 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)
$ echo $?
0
```

```sh
$ mkdir resolutions-ignored && cd resolutions-ignored
$ cat package.json
{ "dependencies": { "to-regex-range": "5.0.1" }, "resolutions": { "is-number": "6.0.0" } }
$ npm install --package-lock-only
$ node -e "console.log(require('./package-lock.json').packages['node_modules/is-number'].version)"
7.0.0
$ overridecheck .
  0 override rules checked  (0 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)

  RESOLUTIONS resolutions                 package.json has a "resolutions" field (is-number@6.0.0) — npm never reads this key. It is Yarn's syntax; against an npm package-lock.json it is dead weight that silently does nothing. Use "overrides" instead.
$ echo $?
1
```

```sh
$ mkdir nested-nonexistent-parent && cd nested-nonexistent-parent
$ cat package.json
{ "dependencies": { "string-width": "4.2.3" },
  "overrides": { "nonexistent-parent-pkg": { "is-fullwidth-code-point": "999.0.0" } } }
$ npm install --package-lock-only
$ overridecheck .
  1 override rule checked  (0 applied, 0 partial, 0 not applied, 1 dead, 0 bad $ref)

  DEAD        nonexistent-parent-pkg      "nonexistent-parent-pkg" is not a package anywhere in this lockfile — this override can never take effect.
$ echo $?
1
```

**Positive controls** — nested override under a real parent, `"$name"`
reference, and range-aware matching against a real minor-version bump (all
`npm install --package-lock-only`, real output):

```sh
$ overridecheck test/fixtures/nested-real-parent-applied   # string-width's own is-fullwidth-code-point forced 3.0.0 -> 4.0.0
  1 override rule checked  (1 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)

$ overridecheck test/fixtures/dollar-ref-applied           # to-regex-range's is-number forced to match root's own "$is-number" (^6.0.0)
  1 override rule checked  (1 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)

$ overridecheck test/fixtures/range-target-applied         # "ansi-styles": "^4.0.0" — npm actually resolved 4.3.0
  1 override rule checked  (1 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)
```

`range-target-applied` is the one that most directly proves range-aware
matching matters: a naive string-equality check ("4.3.0" !== "^4.0.0") would
have called this a false NOT-APPLIED.

**Real-world project**: `microsoft/vscode`'s actual `package.json` and
committed `package-lock.json` (fetched directly from `main`, 1,660 packages,
21,082-line lockfile — both checked into `test/fixtures/real-vscode/`
unmodified). Its real `overrides` block:

```json
"overrides": {
  "@typescript-eslint/types": "8.66.0",
  "node-gyp-build": "4.8.1",
  "kerberos@2.1.1": { "node-addon-api": "7.1.0" },
  "koffi": "3.2.1",
  "serialize-javascript": "^7.0.3",
  "yauzl": "^3.3.1"
}
```

```sh
$ overridecheck test/fixtures/real-vscode
  6 override rules checked  (6 applied, 0 partial, 0 not applied, 0 dead, 0 bad $ref)
$ echo $?
0
```

All six actually took effect — including `serialize-javascript`, resolved to
the real `7.0.5` against a declared `^7.0.3` (another real range-aware match),
and the version-scoped nested rule `kerberos@2.1.1 > node-addon-api`, which
correctly reaches only `node_modules/kerberos/node_modules/node-addon-api`
(forced to `7.1.0`) and correctly leaves the *other* eight unrelated
`node-addon-api` instances elsewhere in the tree alone — that's intentional
scoping, not a bug, and this tool doesn't flag it as one.

**Synthetic scenarios** (`examples/demo.ts`, `node examples/demo.ts` — real
output, hand-built lockfiles as noted above):

```sh
--- partial application: "shared" forced to ^2.0.0, but only 1 of 2 instances satisfy it ---
  1 override rule checked  (0 applied, 1 partial, 0 not applied, 0 dead, 0 bad $ref)

  PARTIAL     shared                      wanted "^2.0.0" — applied at 1 of 2 location(s); NOT applied at 1.0.0 at node_modules/pkg-a/node_modules/shared. A partial application can be worse than none: some code paths get the patched version, others do not.

--- dead override: "kerberos@9.9.9" never matches (the tree only has kerberos@2.1.1) ---
  1 override rule checked  (0 applied, 0 partial, 0 not applied, 1 dead, 0 bad $ref)

  DEAD        kerberos@9.9.9              "kerberos@9.9.9" never matches — the tree only has kerberos@2.1.1, so this override can never take effect.

--- misconfigured override: "$doesnotexist" has no matching root dependency ---
  1 override rule checked  (0 applied, 0 partial, 0 not applied, 0 dead, 1 bad $ref)

  BAD-REF     foo > bar                   overrides "foo > bar" references "$doesnotexist", but the root package.json declares no such dependency — npm cannot resolve this override. Declare a root dependency named "doesnotexist", or use a literal version.
```

## What it does not do

- **It does not scan for known CVEs or tell you which packages need an
  override.** It only checks whether overrides you already declared actually
  applied. Pair it with `npm audit` / Dependabot / Socket for "what's
  vulnerable"; this tool answers "did what I already did about it actually
  work."
- **It does not run `npm install` or touch `node_modules`.** Everything comes
  from the two files you give it, read once, no network calls.
- **pnpm and yarn are out of scope**, not silently mishandled — see "Scope".
- **Hyphen ranges and `"||"` in an override target are refused, not
  guessed at** — see "Range support".
- **A version-scoped parent key's match is computed against the lockfile's
  final, already-resolved version**, not against whatever npm's own resolver
  saw mid-resolution. In every case this was checked against (including the
  vscode fixture) these are the same thing; a contrived case where they
  diverge (the override itself changes the very version a `"pkg@range"` key
  is trying to match) is not something this tool was built or tested against.
- **Workspaces / monorepos**: only the root manifest's `overrides` and the
  lockfile's top-level tree are read. A workspace package's own
  `package.json` overrides (if npm workspaces is even using per-package
  overrides — it generally isn't; `overrides` is root-only by npm's own
  design) aren't a separate concept this tool models.

## Develop

Tests are TypeScript run directly by Node's test runner — no build, no install:

```sh
node --test "test/*.test.ts"    # full suite, needs node 24+ for type stripping
node examples/demo.ts

npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

`test/fixtures/{overrides-applied,resolutions-ignored,nested-nonexistent-parent,
nested-real-parent-applied,dollar-ref-applied,range-target-applied}/package-lock.json`
are real lockfiles from `npm install --package-lock-only` against the public
registry. `test/fixtures/real-vscode/` is `microsoft/vscode`'s actual
`package.json` + `package-lock.json` fetched from its `main` branch. Nothing
else in the suite is real npm output — synthetic cases are labeled `SYNTHETIC`
in `test/check.test.ts` and explain why a real install couldn't produce them.

## License

MIT
