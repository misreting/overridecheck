/** Base class for every error this library throws. */
export class OverrideCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad CLI usage: missing files, too many/few arguments, unknown flags. */
export class InputError extends OverrideCheckError {
  constructor(message: string) {
    super(message);
  }
}

/** package.json or package-lock.json is not valid JSON, or is missing fields
 *  this tool relies on to reason about the dependency tree. */
export class ParseError extends OverrideCheckError {
  constructor(message: string) {
    super(message);
  }
}

/** The lockfile is not an npm package-lock.json (pnpm-lock.yaml, yarn.lock, or
 *  an npm lockfileVersion this tool does not read). See README "Scope". */
export class UnsupportedLockfileError extends OverrideCheckError {
  constructor(message: string) {
    super(message);
  }
}

/** An override target used range syntax this tool's semver engine does not
 *  implement (hyphen ranges, "||" alternatives). Thrown rather than guessed at,
 *  per the house rule: never silently misjudge whether an override applied. */
export class UnsupportedRangeError extends OverrideCheckError {
  constructor(message: string) {
    super(message);
  }
}
