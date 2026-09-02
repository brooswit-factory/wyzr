// The ONLY place in this CLI that writes to stdout/stderr. Both
// human-readable and `--json` output, and both the success and error paths,
// route through these four functions — every one of them scrubs its
// argument with redact() before printing. See README.md for the grep that
// proves nothing else in src/ writes to a std stream, and
// test/unit/redact.test.ts for tests that go through this module's public
// surface and assert a secret never reaches what was actually written.

import { redact } from "./redact.ts";

export function printJson(data: unknown): void {
  console.log(redact(JSON.stringify(data)));
}

export function printHuman(message: string): void {
  console.log(redact(message));
}

export function printError(message: string): void {
  console.error(redact(message));
}

/** `--json` mode's error path: one JSON value to stderr, redacted like everything else. */
export function printJsonError(data: unknown): void {
  console.error(redact(JSON.stringify(data)));
}
