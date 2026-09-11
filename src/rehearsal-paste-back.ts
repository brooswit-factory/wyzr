// `wyzr rehearse-safe-plug-write`'s OWN paste-back path (WYZR-30 review
// finding 2, 2026-09-11). `src/rehearsal-report.ts`'s `toRehearsalJson()`/
// `formatRehearsalHuman()` are UNCHANGED and NEVER import this module —
// identifiers stay legible on the screen an operator reads, same ruling
// `wyzr doctor`'s own README section documents. This module exists ONLY
// for the deliberate, executor-invoked paste-back step
// `docs/write-rehearsal-procedure.md` walks through, the exact same
// relationship `src/capture-format.ts` has to `wyzr doctor`'s/`wyzr
// cycle`'s own live output.
//
// WHY THIS IS A SEPARATE FUNCTION FROM `src/capture-format.ts`'s
// `redactAddressesForPasteBack()`: that function catches IPv4/IPv6/
// IPv4-mapped-IPv6-SHAPED literals only — it has no way to recognize a
// plug's mac or name, neither of which has a detectable SHAPE a regex
// could reliably find (see that module's own "what this module does not
// and cannot do"). MEASURED (WYZR-30 review): a colon-separated mac
// (`AA:BB:CC:DD:EE:01`) happened to survive `redactAddressesForPasteBack()`
// only because it incidentally matches the IPv6-candidate pattern
// (`isIPv6Shaped()` — 4+ colon-separated groups); a dash-separated form, a
// bare (no-separator) form, and a dotted form all SURVIVED untouched, a
// sub-device id shaped `<mac>-SUB1` left the `-SUB1` suffix attached to
// the (accidentally) redacted mac — still disclosing that one existed —
// and the plug's configured NAME survived in every case. This module
// closes the gap by VALUE, not by shape: it knows THIS run's own
// configured `mac`/`name`/`subDeviceId` (`RehearsalSafePlugIdentity`,
// src/rehearsal-runner.ts) and elides exactly those strings, wherever
// they appear and however they are spelled in `text`.
//
// WHAT THIS COVERS, PROVABLY COMPREHENSIVELY, FOR THIS COMMAND SPECIFICALLY:
// unlike `wyzr doctor`/`wyzr cycle --dry-run` (whose `--json` output also
// carries the wrong-box guard's own resolved addresses and, in principle,
// a configured hostname), `src/rehearsal-report.ts`'s `RehearsalJson` names
// NO host, unit, or address anywhere — this command never runs the
// wrong-box guard at all (see src/rehearsal-runner.ts's own "no gate, no
// wrong-box guard" comment). The ONLY identifiers this command's own
// evidence trail can ever contain are the safe plug's own `mac`/`name`/
// `subDeviceId` — every occurrence of which this module elides — so
// `renderRehearsalForPasteBack()` below is a comprehensive redaction FOR
// THIS COMMAND'S OWN OUTPUT SHAPE, not merely a best-effort pattern match.
//
// WHAT THIS DOES NOT COVER, STATED EXPLICITLY: a thrown transport/auth
// error's `.message` (surfaced verbatim in `writeErrorMessage`/
// `preconditions.note`, per this repo's own "never re-interpret a thrown
// error" discipline — src/cycle-runner.ts's own comment) is relayed as-is;
// this repo's transport layer is built never to echo a request value into
// an error message (see e.g. src/config.ts's/src/credentials.ts's own
// "no error path echoes a value" rule), but that is a property of THOSE
// modules, not something this function can verify for arbitrary future
// error text — stated as an assumption, not proven here.

import { redactAddressesForPasteBack } from "./capture-format.ts";
import type { RehearsalSafePlugIdentity } from "./rehearsal-runner.ts";

export const SAFE_PLUG_IDENTITY_REDACTED = "<safe-plug-identity-redacted>";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Elides every occurrence of `identity`'s own `mac`/`name`/`subDeviceId`
 * from `text` — LONGEST value first, so a mac that is itself a literal
 * substring of a compound `subDeviceId` (the common `<mac>-SUB1` shape) is
 * consumed as part of the LONGER match, never left as a partial,
 * still-identifying fragment (the exact leak the review measured).
 * Case-insensitive and matched as a literal substring (not a word
 * boundary): a mac is not case-sensitive on the wire, and this command
 * never re-cases the configured value, but a future reader who does
 * should not silently defeat this.
 */
export function redactSafePlugIdentityForPasteBack(text: string, identity: RehearsalSafePlugIdentity): string {
  const values = [identity.subDeviceId, identity.mac, identity.name]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .toSorted((a, b) => b.length - a.length);

  let out = text;
  for (const value of values) {
    out = out.replace(new RegExp(escapeRegExp(value), "gi"), SAFE_PLUG_IDENTITY_REDACTED);
  }
  return out;
}

/**
 * The ONE function `docs/write-rehearsal-procedure.md` tells an executor
 * to run their captured raw output through before any paste-back —
 * composes BOTH redactions (this run's own plug identity, then any
 * IP-shaped literal) so there is exactly one call site to remember, per
 * property 5's own "design it so following the procedure cannot cause the
 * executor to paste one." Order matters only cosmetically here (a
 * colon-form mac would otherwise be caught, and correctly redacted, by
 * `redactAddressesForPasteBack()` alone) — identity redaction runs FIRST
 * so every identifier this command controls is scrubbed with the SAME
 * placeholder, regardless of which pattern would have also caught it.
 */
export function renderRehearsalForPasteBack(rawOutput: string, identity: RehearsalSafePlugIdentity): string {
  return redactAddressesForPasteBack(redactSafePlugIdentityForPasteBack(rawOutput, identity));
}
