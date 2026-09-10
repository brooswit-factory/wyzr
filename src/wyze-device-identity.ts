// The DEVICE host's (api.wyzecam.com) "standard body" fields — required on
// EVERY call to that host, per WYZR-15's live-account measurement
// (RELAYED: assistant → project → epic → this ticket, NOT observed
// directly by this repo's own authors — see src/transport-http.ts's header
// comment for the full chain and what that provenance means). A call
// carrying only its own call-specific fields (e.g. `{access_token}` alone
// for `get_object_list`) is REJECTED with a device-host body error
// (`{"code":"1001","msg":"INVALID_PARAMETER"}`) — this is not optional
// metadata, it is a precondition the device host enforces on every call.
//
// === THE DECISION THIS FILE RECORDS, EXPLICITLY, PER THE TICKET'S OWN
// REQUIREMENT ===
//
// This product's Confluence root doc previously recorded a DELIBERATE
// CHOICE: wyzr mints its own app-identity value (see the now-retired
// src/app-identity.ts, kept in git history) rather than lifting the
// community `wyze-sdk`'s embedded static identity. `sc`/`sv` below are, by
// every visible signature (32-character lowercase hex, paired with
// `app_ver`/`app_name` naming the exact same app package the community SDK
// impersonates), that SAME static app identity — this project simply did
// not have it before this measurement, because the earlier research
// (docs/wyze-api-findings-2026-09-02.md) explicitly declined to reproduce
// it out of another project's source without independent confirmation it
// was even required.
//
// STATE THIS PRECISELY — the ticket carrying this correction RETRACTED an
// earlier overstatement of exactly this claim, and named that retraction
// as an instance of the general trap this whole ticket exists to fix (a
// plausible-sounding conclusion drawn one step past what was measured):
//   MEASURED: the device host ACCEPTED these exact sc/sv/app_ver/app_name/
//   app_version values, verbatim, on a request that a bare `{access_token}`
//   body (this project's pre-WYZR-15 shape) got REJECTED for.
//   NEVER TESTED: whether a MINTED identity in the same field slots would
//   be refused. Nobody has run that experiment.
// "The static values work" is a fact this file ships on. "A minted
// identity cannot work" is NOT a finding, and this file does not claim
// it, and neither should anything that cites this file. wyzr adopts the
// STATIC values here because they are the only ones ever shown to work,
// not because the minted-identity alternative was tested and lost — that
// experiment is cheap but has to run against the real device host, which
// this project has no access to (see the ticket's "no credentials, ever"
// rule). Per the ticket carrying this correction: these constants are NOT
// secrets — they are a public app identity baked into open-source client
// code, the same way a User-Agent string is public — unlike the
// tokens/credentials sent alongside them, which remain secrets and stay
// covered by src/redact.ts.
//
// This does NOT resurrect src/app-identity.ts's `x-api-key` header — but
// STATE WHY PRECISELY, per this same file's own "measured vs untested"
// discipline above: the two hosts are NOT in the same evidentiary state.
// The auth host's working login request was measured with its FULL header
// set (`keyid`, `apikey`, `content-type`) — no `x-api-key` among them —
// so "the working login doesn't carry it" is a genuine observation. The
// device host's relayed measurement recorded a BODY only; it never
// recorded that request's headers at all, in either direction. "No
// measured working device-host call carries that header" would be the
// same shape of overclaim this file just spent a paragraph warning
// against (absence of a record misread as a record of absence) — so this
// file does NOT claim that. The header is retired for the device host as
// the DEFENSIBLE DEFAULT (an unobserved header nobody has evidence for is
// not something to keep sending on a guess), not because any request was
// observed to work without it. See src/transport-http.ts's header comment
// for where it used to be sent.

import { createHash } from "node:crypto";

/** The community app's own identifiers, exactly as measured on the working
 * device-host request (WYZR-15, relayed). Read them from this one place;
 * do not inline them at call sites. */
export const DEVICE_STANDARD_BODY_SC = "a626948714654991afd3c0dbd7cdb901";
export const DEVICE_STANDARD_BODY_SV = "e1fe392906d54888a9b99b88de4162d7";
export const DEVICE_STANDARD_BODY_APP_VER = "com.hualai.WyzeCam___2.19.14";
export const DEVICE_STANDARD_BODY_APP_NAME = "com.hualai.WyzeCam";
export const DEVICE_STANDARD_BODY_APP_VERSION = "2.19.14";
/** Measured as the STRING `"1"` (quoted in the ticket's own transcript),
 * unlike `ts` below (shown unquoted — sent as a JSON number). */
export const DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE = "1";

/** The measurement's own note on `phone_id` is "`<any string>`" — i.e. it
 * was NOT shown to need a specific value, only SOME value. wyzr mints its
 * own stable one (the same "derive our own, don't lift one we can't
 * confirm we need" posture app-identity.ts used, still appropriate here
 * because THIS field, unlike `sc`/`sv`, was never shown to need a specific
 * value): a SHA-256 hex digest of a fixed, versioned, wholly-public seed
 * string naming this project. Fixed per process, not per call — nothing in
 * the measurement suggested it needs to vary. */
export const DEVICE_PHONE_ID_SEED = "wyzr-device-phone-id-v1" as const;
export const DEVICE_PHONE_ID: string = createHash("sha256").update(DEVICE_PHONE_ID_SEED, "utf8").digest("hex");

/**
 * The full standard-body field set, merged into every api.wyzecam.com
 * call's JSON body (login/submitMfa, on the auth host, do NOT get this —
 * see src/transport-http.ts). `ts` is generated fresh per call via the
 * injected clock (defaults to `Date.now()`), as a bare JSON number, per
 * the measurement's unquoted `ts: <epoch ms>` transcript.
 */
export function deviceStandardBody(now: () => number = Date.now): Record<string, unknown> {
  return {
    sc: DEVICE_STANDARD_BODY_SC,
    sv: DEVICE_STANDARD_BODY_SV,
    app_ver: DEVICE_STANDARD_BODY_APP_VER,
    app_name: DEVICE_STANDARD_BODY_APP_NAME,
    app_version: DEVICE_STANDARD_BODY_APP_VERSION,
    phone_id: DEVICE_PHONE_ID,
    phone_system_type: DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE,
    ts: now(),
  };
}
