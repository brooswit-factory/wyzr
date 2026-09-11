// The doctor's own read-only plug boundary (WYZR-29). Two independent,
// pure-where-possible pieces:
//
// - `isPlugResolvable()`: zero I/O, a plain lookup against an
//   already-fetched device list — "does the configured mac exist on this
//   account at all?"
// - `checkPlugReadable()`: the one function in this whole command that is
//   typed to accept ONLY a `PlugReader` (src/cycle-plug.ts) — never a
//   `PlugWriter`. `PlugReader` is REUSED, not re-declared: it is the exact
//   type `wyzr cycle --dry-run` already relies on to make "no write call
//   compiles here" a property the compiler enforces, not a convention this
//   file promises to follow. See test/unit/doctor-plug.test.ts's own
//   `@ts-expect-error` pin, mutation-tested per the ticket's own
//   instruction (temporarily typing the same call site as `PlugWriter`
//   makes that pin's directive UNUSED, and `bun run typecheck` then fails
//   loudly on it — see the PR body for the captured transcript).
//
// WHAT THIS FILE CAN AND CANNOT SEE, stated per the ticket's own
// requirement: `checkPlugReadable()` proves that within this specific
// function body, only `readState()` is visible to the compiler — it does
// NOT prove no OTHER file in this command's own dependency tree could
// still import a write-capable module. That second property is
// test/unit/doctor-imports.test.ts's job (an import-closure walk) and
// test/unit/doctor-no-write.test.ts's job (a source-level grep for
// `setProperty(`/`writePower(` across this command's own new files) — three
// different checks, each blind to what the other two catch; see the PR
// body for what each one specifically cannot see.

import type { PlugReader } from "./cycle-plug.ts";
import type { CheckOutcome } from "./recovery.ts";
import type { DeviceRecord } from "./devices.ts";

function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase();
}

/**
 * `true` when `target`'s mac exactly matches (case-insensitive, trimmed —
 * same normalisation src/config.ts's own `samePlugIdentity()` and
 * src/cycle-wrong-box.ts's identity comparisons already use) some device in
 * `devices`. Zero I/O — `devices` must already have been fetched by the
 * caller. WHAT THIS CANNOT SEE: a device list that is paginated, stale, or
 * itself incomplete would make a real device read "not resolvable" here —
 * this is a syntactic membership check over whatever list the caller
 * handed it, not proof the account does not have the device.
 */
export function isPlugResolvable(devices: readonly DeviceRecord[], targetMac: string): boolean {
  const needle = normalizeMac(targetMac);
  return devices.some((d) => d.mac !== null && normalizeMac(d.mac) === needle);
}

export interface PlugReadableResult {
  readonly outcome: CheckOutcome;
  readonly note: string | null;
}

/**
 * Attempts exactly one read of `plug`'s P3/P5 state. `"fail"` only for a
 * genuine thrown transport/auth/API error (relayed verbatim — see this
 * module's own top comment and src/cycle-plug.ts's `PlugReader.readState()`
 * doc comment: a thrown error means nothing was observed at all).
 * `"could-not-look"` for an observed-but-undecodable reading (`power ===
 * "unknown"` or `reachable === null`) — the read completed, the device
 * just did not answer confidently; never conflated with a thrown failure.
 * `"pass"` only when BOTH P3 and P5 decoded.
 */
export async function checkPlugReadable(plug: PlugReader): Promise<PlugReadableResult> {
  let reading: Awaited<ReturnType<PlugReader["readState"]>>;
  try {
    reading = await plug.readState();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { outcome: "fail", note: message };
  }

  if (reading.power === "unknown" || reading.reachable === null) {
    return {
      outcome: "could-not-look",
      note: reading.note ?? "P3 (power) and/or P5 (reachability) could not both be decoded from this read",
    };
  }

  return { outcome: "pass", note: `power=${reading.power} reachable=${String(reading.reachable)}` };
}
