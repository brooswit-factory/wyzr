// The Wyze DEVICE host's response envelope (api.wyzecam.com) — every
// getObjectList/getPropertyList/setProperty call, AND refreshToken (which
// src/transport-http.ts also routes to the device host, not the auth
// host — see src/transport.ts's WyzeTransport doc comment):
//   {"code": ..., "msg": ..., "data": {...}}
//
// *** THIS IS NOT THE AUTH HOST'S SHAPE. *** An earlier version of this
// comment claimed the envelope above held "on every call (auth and
// device alike)" — WRONG, and the root cause WYZR-15 fixed. MEASURED
// 2026-09-10 against the real auth host (auth-prod.api.wyze.com, reached
// only via login()/submitMfa()) with placeholder credentials: its error
// response carries NONE of `code`/`msg`/`data` — only
// `description`/`errorCode`/`requestId` at the top level — and answers
// HTTP 400, not this host's always-200. See
// docs/wyze-api-findings-2026-09-02.md §Q3's 2026-09-10 correction, and
// src/wyze-auth-envelope.ts for the auth host's OWN envelope type/module —
// login()/submitMfa() return that type now, never this one.
//
// For THIS host (device), the finding's claims stand, now partly
// upgraded: `code == "1"` (success) is a STRING, not the number 1, and
// `code == 1000` (invalid credentials / too-many-failed-attempts) and
// `code == 2001` (access token expired) were tier (b) (community-SDK-
// sourced). WYZR-15's own device-host measurement
// (`get_property_list` with a placeholder access token: HTTP 200,
// `{"code":"1001","msg":"INVALID_PARAMETER","data":{}}`) directly
// confirms the {code,msg,data} SHAPE at tier (a) for THIS host's error
// path — individual code values not exercised by that measurement stay
// at their prior tier. This module is deliberately defensive about
// wire-type ambiguity regardless: every comparison below normalizes
// `code` to a string first, so a wire value of the number 1000 and the
// string "1000" are handled identically. That is the answer to "how did
// you handle the string-vs-number ambiguity" for the PR body.
//
// isInvalidCredentialsCode() and detectMfaChallenge() below are kept as
// general DEVICE-envelope utilities (tested, harmless) even though
// nothing in src/ currently calls them for a real request — login()/
// submitMfa() now use src/wyze-auth-envelope.ts's own
// isAuthInvalidCredentialsCode()/detectAuthMfaChallenge() instead, since
// those calls hit the auth host, not this one. That is criterion 4's
// "explicitly scoped to the device host" branch, not a bug: nothing here
// asserts the device host DOES send an errorCode-1000-shaped response or
// an MFA challenge, only that IF it ever did, this module's own
// primitives — scoped to this envelope's shape — would be the right tool,
// not wyze-auth-envelope.ts's.

/** The raw, mostly-untyped shape returned by every WyzeTransport call.
 * `data`'s real shape depends on which call produced it — see transport.ts
 * for the per-call typed accessors built on top of this. */
export interface WyzeEnvelope {
  code: unknown;
  msg: unknown;
  data: unknown;
}

/** `String(code)` — the single place that resolves the string-vs-number
 * wire-type ambiguity for every comparison in this module. */
export function normalizeCode(code: unknown): string {
  return String(code);
}

/** `msg` as a string, or `""` if absent — never `"undefined"`/`"null"`. */
export function normalizeMsg(msg: unknown): string {
  return msg === undefined || msg === null ? "" : String(msg);
}

/** `code == "1"` (string), per the finding. Device-host envelope only —
 * used for refreshToken()/getObjectList()/getPropertyList()/setProperty()
 * responses. login()/submitMfa() use src/wyze-auth-envelope.ts's own
 * isAuthSuccessEnvelope() instead (see this file's header comment). */
export function isSuccessEnvelope(envelope: WyzeEnvelope): boolean {
  return normalizeCode(envelope.code) === "1";
}

/** `code == 1000` — invalid credentials, OR an SSO-only account with no
 * Wyze-native password (see wyze-errors.ts for the message this maps to).
 * Device-host envelope only, kept as a general utility though nothing in
 * src/ currently calls it — see this file's header comment for why, and
 * src/wyze-auth-envelope.ts's isAuthInvalidCredentialsCode() for the
 * function that actually handles this code on the auth host. */
export function isInvalidCredentialsCode(envelope: WyzeEnvelope): boolean {
  return normalizeCode(envelope.code) === "1000";
}

/** `code == 2001` OR `msg == "AccessTokenError"` — the access token has
 * expired and must be refreshed. Checked as an OR, per the finding, since
 * either signal alone is documented as sufficient. */
export function isAccessTokenExpired(envelope: WyzeEnvelope): boolean {
  return normalizeCode(envelope.code) === "2001" || normalizeMsg(envelope.msg) === "AccessTokenError";
}

/**
 * Detects a pending MFA challenge from `data`'s shape, INDEPENDENTLY of
 * `code` — checked before any code-based branching elsewhere. This is a
 * deliberate design choice, not an oversight: the finding establishes that
 * a TOTP/SMS challenge can occur (tier (b)) but names no `code` value that
 * accompanies it (explicit unknown, see docs/wyze-api-findings, §3 unknown
 * #1/#2 and the auth-session.ts module comment). Gating detection on `data`
 * shape instead of a guessed `code` value means this keeps working
 * regardless of what that unresolved code value turns out to be.
 *
 * The exact field names read here (`mfa_options`, `verification_id`,
 * `sms_session_id`) are THIS AUTHOR'S INFERENCE (tier (d)) — modeled on the
 * common shape of reverse-engineered mobile-app MFA flows, not confirmed
 * against any captured real Wyze payload (none exists in any (a)/(b)-tier
 * source per the finding). Expect this to need correction against a real
 * account; see README's "Live-device coverage" section.
 *
 * Device-host envelope only, kept as a general utility though nothing in
 * src/ currently calls it — MFA only ever arises from login()/submitMfa(),
 * which hit the auth host and are read with
 * src/wyze-auth-envelope.ts's own detectAuthMfaChallenge() instead (see
 * this file's header comment).
 */
export function detectMfaChallenge(envelope: WyzeEnvelope): MfaChallenge | undefined {
  const data = envelope.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const options = obj["mfa_options"];
  if (!Array.isArray(options) || options.length === 0) {
    return undefined;
  }
  const verificationId = obj["verification_id"] ?? obj["sms_session_id"];
  if (typeof verificationId !== "string" || verificationId.length === 0) {
    return undefined;
  }

  const normalizedOptions = options.map((o) => String(o).toLowerCase());
  const mfaType: MfaChallenge["mfaType"] = normalizedOptions.some((o) => o.includes("totp"))
    ? "TOTP"
    : normalizedOptions.some((o) => o.includes("phone") || o.includes("sms"))
      ? "SMS"
      : "UNKNOWN";

  return { mfaType, verificationId };
}

export interface MfaChallenge {
  mfaType: "TOTP" | "SMS" | "UNKNOWN";
  verificationId: string;
}

/** Extracts `access_token`/`refresh_token` from a successful envelope's
 * `data`. Throws a plain Error (callers wrap it) if either is missing or
 * not a string — a `code == "1"` response without both tokens is a
 * malformed response, not a normal branch to design around silently.
 * Device-host only as of WYZR-15: exercised by refreshToken()'s response
 * (src/auth-session.ts's refresh()) — login()/submitMfa() use
 * src/wyze-auth-envelope.ts's own extractAuthTokens() instead, since the
 * auth host's tokens live at the top level, not nested under `data`. */
export function extractTokens(envelope: WyzeEnvelope): { accessToken: string; refreshToken: string } {
  const data = envelope.data;
  if (typeof data !== "object" || data === null) {
    throw new Error("Wyze login/refresh response was successful but had no data object.");
  }
  const obj = data as Record<string, unknown>;
  const accessToken = obj["access_token"];
  const refreshToken = obj["refresh_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Wyze login/refresh response was successful but had no access_token.");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Wyze login/refresh response was successful but had no refresh_token.");
  }
  return { accessToken, refreshToken };
}
