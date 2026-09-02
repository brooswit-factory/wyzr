// Security core: scrubs registered secret values, plus generic
// credential-bearing shapes, out of text before it is printed.
// src/output.ts routes every stdout/stderr write through `redact()` so
// there is no path to the terminal that bypasses it — see
// test/unit/redact.test.ts for the proof.

export const REDACTED = "***REDACTED***";

const secrets = new Set<string>();

/**
 * Register a value (e.g. an API key secret) to be scrubbed from all future
 * output. No-op for empty/undefined/null values so an unset credential can
 * never accidentally register the empty string and redact everything (every
 * string contains the empty string).
 */
export function registerSecret(value: string | undefined | null): void {
  if (value) {
    secrets.add(value);
  }
}

/**
 * Generic credential-bearing shapes to scrub even when the value was never
 * explicitly registered — the transport story that lands the real Wyze
 * request shape should extend this list rather than relying solely on
 * registerSecret(). Case-insensitive. Each pattern's capturing group is the
 * prefix (header/key name, separator, and any opening quote) to keep; only
 * the value after it is replaced. Matches both a plain header line
 * (`Authorization: Bearer xyz`) and the same shape JSON-quoted inside a
 * dumped request/response object (`"Authorization":"Bearer xyz"`).
 */
const VALUE = `[^"'\\s,}]+`;
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  new RegExp(`("?Authorization"?\\s*:\\s*"?Bearer\\s+)(${VALUE})`, "gi"),
  new RegExp(`("?Authorization"?\\s*:\\s*"?)(?!Bearer\\s)(${VALUE})`, "gi"),
  new RegExp(`("?X-API-Key"?\\s*:\\s*"?)(${VALUE})`, "gi"),
  new RegExp(`("?Apikey"?\\s*:\\s*"?)(${VALUE})`, "gi"),
  new RegExp(`("?Keyid"?\\s*:\\s*"?)(${VALUE})`, "gi"),
  /("access_token"\s*:\s*")([^"]+)/gi,
  /("refresh_token"\s*:\s*")([^"]+)/gi,
];

/**
 * Scrub every registered secret, plus every shape in CREDENTIAL_PATTERNS
 * (even for a value that was never explicitly registered), from `text`.
 */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  return out;
}

/** Test-only: clear the registry so one test's registrations can't leak into another. */
export function resetSecretsForTesting(): void {
  secrets.clear();
}
