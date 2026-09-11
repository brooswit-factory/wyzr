// The ONLY way a Wyze secret enters this process. Loads
// `<config base>/wyzr/credentials.json`, refuses to read an
// over-permissive file (or directory), and registers every secret field
// with src/redact.ts's registry *before* returning it, so there is no
// window in which a caller could print a secret before it is protected.
//
// This module never uses the credentials it loads — no HTTP, no hashing,
// no MFA handling. It hands typed values to whatever loads it next; see
// the ticket for why that boundary matters.

import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CliError, ExitCode } from "./errors.ts";
import { registerSecret } from "./redact.ts";

/** The env vars credentials-file resolution reads. Narrower than
 * `NodeJS.ProcessEnv` so a test can pass a plain object instead of
 * mutating the real `process.env` — see README's XDG section. */
export interface CredentialsEnv {
  XDG_CONFIG_HOME?: string | undefined;
  HOME?: string | undefined;
}

// bun-types declares NodeJS.ProcessEnv with only NODE_ENV/TZ and no index
// signature, so `process.env` itself is not structurally assignable to
// CredentialsEnv. Cast once, here, rather than at every call site.
const systemEnv: Record<string, string | undefined> = process.env as unknown as Record<
  string,
  string | undefined
>;

/** The typed shape this module hands to its caller. `totpSecret` is the
 * only optional field — present only for an account with MFA configured. */
export interface Credentials {
  email: string;
  password: string;
  keyId: string;
  keySecret: string;
  totpSecret: string | undefined;
}

const REQUIRED_STRING_FIELDS = ["email", "password", "keyId", "keySecret"] as const;
const OPTIONAL_STRING_FIELDS = ["totpSecret"] as const;
const KNOWN_FIELDS = new Set<string>([...REQUIRED_STRING_FIELDS, ...OPTIONAL_STRING_FIELDS]);

/** `$XDG_CONFIG_HOME/wyzr` when XDG_CONFIG_HOME is set and non-empty,
 * else `$HOME/.config/wyzr` — the ONE directory-resolution rule every
 * file this CLI reads from disk shares. Exported (WYZR-20/WYZR-28) so
 * `src/config.ts`'s `config.json` loader reuses this exact resolution
 * rather than writing a second one, which is how a config file and a
 * credentials file could otherwise end up looking in two different
 * places for no reason — this module is "internal, free to change" per
 * README's published-interface section, so widening its export surface
 * for another module in this repo to reuse is safe. `credentialsDir`
 * below is kept as a same-behavior alias: it names what THIS file uses
 * this resolution for, and every existing caller/test keeps working
 * unchanged.
 *
 * The error path here throws `ExitCode.CredentialsInvalid` even when the
 * caller is `src/config.ts` — this failure ("no config directory can be
 * located at all") happens before either file's own identity is known,
 * so there is no more specific exit code to prefer; `src/config.ts`'s own
 * `ExitCode.ConfigInvalid` is for a config.json this function successfully
 * located a directory for. */
export function wyzrConfigDir(env: CredentialsEnv = systemEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, "wyzr");
  }
  const home = env.HOME;
  if (!home || home.length === 0) {
    throw new CliError(
      "Cannot locate a config directory: neither XDG_CONFIG_HOME nor HOME is set.",
      ExitCode.CredentialsInvalid,
      "credentials_no_home",
    );
  }
  return join(home, ".config", "wyzr");
}

/** Same-behavior alias for `wyzrConfigDir` — kept so this module's own
 * existing name/usage (and `test/unit/credentials.test.ts`) is untouched. */
export const credentialsDir = wyzrConfigDir;

export function credentialsPath(env: CredentialsEnv = systemEnv): string {
  return join(credentialsDir(env), "credentials.json");
}

function credentialsError(message: string, reason: string): CliError {
  return new CliError(message, ExitCode.CredentialsInvalid, reason);
}

/** `mode & 0o077` — any of the low 6 bits (group or other: rwx) set. */
function isOverPermissive(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

async function checkMode(path: string, kind: "directory" | "file", fixMode: string): Promise<void> {
  const info = await stat(path);
  if (isOverPermissive(info.mode)) {
    const octal = (info.mode & 0o777).toString(8).padStart(3, "0");
    throw credentialsError(
      `Credentials ${kind} ${path} is readable by group or others (mode ${octal}). ` +
        `Refusing to load credentials. Fix with: chmod ${fixMode} ${path}`,
      kind === "directory" ? "credentials_dir_mode" : "credentials_file_mode",
    );
  }
}

function requireObject(parsed: unknown, path: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw credentialsError(
      `Credentials file at ${path} must contain a single JSON object.`,
      "credentials_shape",
    );
  }
  return parsed as Record<string, unknown>;
}

function requireStringField(obj: Record<string, unknown>, field: string, path: string): string {
  if (!(field in obj)) {
    throw credentialsError(
      `Credentials file at ${path} is missing required field "${field}".`,
      "credentials_field_missing",
    );
  }
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw credentialsError(
      `Credentials file at ${path} has field "${field}" that must be a non-empty string.`,
      "credentials_field_invalid",
    );
  }
  return value;
}

// An empty string is treated the same as absent (not just undefined/null):
// downstream MFA branching needs "is a TOTP secret configured" to be a
// clean boolean check, and a naive `!== undefined` reading of `""` as
// "configured" would produce a confusing TOTP failure instead of this
// module's own clear "no TOTP secret configured" contract. Fixed here at
// the source, rather than requiring every caller to re-apply a falsy check,
// so the exported type's optionality actually means what it says.
function optionalStringField(obj: Record<string, unknown>, field: string, path: string): string | undefined {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
    return undefined;
  }
  const value = obj[field];
  if (typeof value !== "string") {
    throw credentialsError(
      `Credentials file at ${path} has field "${field}" that must be a string.`,
      "credentials_field_invalid",
    );
  }
  return value.length === 0 ? undefined : value;
}

/**
 * Load, validate, and return credentials from
 * `<config base>/wyzr/credentials.json`. Registers `password`, `keySecret`
 * and `totpSecret` with the redaction registry before returning — every
 * failure path below is checked to never include any part of a secret's
 * value in its error message, only field names.
 *
 * Every failure — missing file, bad mode, malformed JSON, wrong shape,
 * missing/mistyped field — throws a `CliError` on `ExitCode.CredentialsInvalid`.
 */
export async function loadCredentials(env: CredentialsEnv = systemEnv): Promise<Credentials> {
  const dir = credentialsDir(env);
  const path = credentialsPath(env);

  try {
    await access(path, fsConstants.F_OK);
  } catch {
    throw credentialsError(
      `No credentials file found at ${path}. Create it as JSON with fields: ` +
        `email, password, keyId, keySecret, and optionally totpSecret.`,
      "credentials_missing",
    );
  }

  // Checked in outer-to-inner order: a directory an attacker can write to
  // can replace the file entirely, so its mode matters independently of
  // the file's own mode.
  await checkMode(dir, "directory", "700");
  await checkMode(path, "file", "600");

  const raw = await readFile(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw credentialsError(`Credentials file at ${path} is not valid JSON.`, "credentials_malformed");
  }

  const obj = requireObject(parsed, path);

  for (const field of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(field)) {
      throw credentialsError(
        `Credentials file at ${path} has unknown field "${field}".`,
        "credentials_unknown_field",
      );
    }
  }

  const email = requireStringField(obj, "email", path);
  const password = requireStringField(obj, "password", path);
  const keyId = requireStringField(obj, "keyId", path);
  const keySecret = requireStringField(obj, "keySecret", path);
  const totpSecret = optionalStringField(obj, "totpSecret", path);

  // Register every secret before returning — no call site downstream can
  // print a value before it is protected. email/keyId are identifiers, not
  // secrets (see README), and are deliberately not registered: they are
  // more likely to be short/common substrings, and a substring-matching
  // redactor over-scrubbing on one would corrupt unrelated output.
  registerSecret(password);
  registerSecret(keySecret);
  registerSecret(totpSecret);

  return { email, password, keyId, keySecret, totpSecret };
}
