// The Wyze AUTH host's own response envelope (auth-prod.api.wyze.com,
// reached only via login()/submitMfa() — see src/transport.ts). Modeled
// SEPARATELY from src/wyze-envelope.ts's DEVICE-host {code,msg,data}
// envelope, on purpose: an earlier version of this project treated one
// envelope shape as universal ("on every call, auth and device alike" —
// see wyze-envelope.ts's corrected header comment), and every function
// that read `envelope.code`/`envelope.data` against a real auth-host
// response silently got `undefined` for all three, because the auth host
// never sends `code`/`msg`/`data` at all. WYZR-15 is that fix; this
// module is the auth host's own family, so the mistake is not expressible
// again — src/transport.ts's WyzeTransport interface types login() and
// submitMfa() as returning THIS type, never WyzeEnvelope.
//
// PROVENANCE, per field — see docs/wyze-api-findings-2026-09-02.md §Q3's
// 2026-09-10 correction for the same claims in that document's own style:
//
// - ERROR shape (`description`/`errorCode`/`requestId` at the TOP LEVEL,
//   HTTP 400): tier (a), directly measured against the real auth host
//   with placeholder credentials. Reproduced independently by two agents
//   on two hosts under two Atlassian identities before this ticket
//   existed, reproduced again as this ticket's own first action, and
//   swept across three more placeholder inputs (a bad keyid, a missing
//   required field, a non-JSON body) in this ticket's own criterion-9
//   sweep — the {description,errorCode,requestId} SHAPE held in every
//   case that returned a JSON body; `errorCode` itself varied (1000 for
//   bad-password/keyid/apikey, 5000 — "Internal Error" — for a missing
//   required field). See the PR body for the raw transcripts.
// - SUCCESS shape (`access_token`/`refresh_token`/`user_id` at the TOP
//   LEVEL, NOT nested under a `data` key, plus `mfa_options`/
//   `mfa_details`/`sms_session_id`/`email_session_id` present-but-`null`):
//   RELAYED — measured against a REAL, human-provisioned account by an
//   assistant on a separate box, relayed assistant → project → epic →
//   this ticket → this module (four hops). NOBODY WHO WROTE THIS MODULE
//   OBSERVED IT DIRECTLY — this repo's own authors have no Wyze account
//   and will not create one (see the ticket's hard "no credentials, ever"
//   rule); a transcription error at any hop would be silently wrong. Also
//   corroborated tier (b) by reading the community `shauntarves/wyze-sdk`
//   Python source directly (`wyze_sdk/service/auth_service.py`,
//   `wyze_sdk/service/wyze_response.py`, read 2026-09-10):
//   `WyzeResponse.__getitem__`/`.get()` index `self.data` — the raw
//   parsed body, no nested `data` key of its own — and `user_login()`
//   reads `response["access_token"]` off exactly that object. The
//   reference implementation expects the auth host's tokens at the top
//   level too. `wyze_response.py`'s own `validate()` also falls back from
//   `code` to `errorCode` (`self.data.get("code", self.data.get
//   ("errorCode", 1))`, defaulting to 1 — success — when NEITHER is
//   present) and from `msg` to `description` — independent corroboration
//   that a real success response likely carries neither `code` nor `msg`
//   at all, and that `description` is the auth host's analogue of the
//   device host's `msg`.
// - MFA shape (`mfa_options` at the top level; a TOTP verification id at
//   `mfa_details.totp_apps[0].app_id`; an SMS session id at
//   `sms_session_id`): STILL tier (d), STILL unobserved by anyone — the
//   one relayed real login above did NOT trigger a challenge
//   (`mfa_options`/`mfa_details` came back `null` on that account), so
//   this shape gained NO confidence from that measurement; do not read it
//   as strengthened just because its sibling shapes now are. Corroborated
//   tier (b) by the same source read — `user_login()` reads exactly those
//   paths off the login response. This SUPERSEDES this project's own
//   earlier, unconfirmed guess of a flat top-level `verification_id`
//   field (still what wyze-envelope.ts's detectMfaChallenge() assumes,
//   left alone there because nothing measured or read contradicts it for
//   the DEVICE host specifically).
//
// STILL UNKNOWN, explicitly, not guessed: whether a real auth-host
// success response carries any field beside the two tokens (e.g.
// `user_id`); the exact SMS challenge/answer flow (the community SDK's
// own `user_login()` makes a SECOND call, to a different endpoint, to
// resolve an SMS session — irrelevant here since wyzr never answers SMS,
// see wyze-errors.ts's wyzeMfaSmsUnsupportedError()); and everything
// else docs/wyze-api-findings-2026-09-02.md §5 already lists as
// unknowable without a real account.

import { normalizeCode, normalizeMsg, type MfaChallenge } from "./wyze-envelope.ts";

export type { MfaChallenge };

/** The auth host's raw response: an HTTP status plus whatever top-level
 * JSON object it returned. Unlike WyzeEnvelope (wyze-envelope.ts), there
 * is no `data` wrapper — every field this module reads (`access_token`,
 * `mfa_options`, `errorCode`, ...) lives directly on `raw`.
 *
 * `httpStatus` is carried through (structural fact: the auth host signals
 * an error via HTTP 400, while the device host always answers HTTP 200
 * and carries its error in the body — the two hosts invert the HTTP
 * status signal). Every function below classifies a response by BODY
 * SHAPE, not by `httpStatus` — deliberately: keying detection on status
 * is exactly the mistake that would misclassify the device host if this
 * module's logic were ever reused there. `httpStatus` exists for
 * diagnostics only (an unrecognized-shape error can still say what HTTP
 * status came back), never as a branch condition. */
export interface WyzeAuthEnvelope {
  httpStatus: number;
  raw: Record<string, unknown>;
}

/** True when `raw` carries the MEASURED auth-error shape's `errorCode`
 * field. Checked by PRESENCE, not by normalizeCode()'s stringified
 * result, so an absent field is never confused with a wire value that
 * happens to stringify to `"undefined"`. */
export function isAuthErrorEnvelope(envelope: WyzeAuthEnvelope): boolean {
  return "errorCode" in envelope.raw;
}

/** `errorCode`, normalized exactly like the device host's `code` — REUSES
 * wyze-envelope.ts's normalizeCode() rather than adding a second
 * normalizer, per the ticket's explicit instruction. MEASURED as the JSON
 * NUMBER 1000 on the auth host (never the string); normalizeCode()
 * absorbs that identically to how it already absorbs the device host's
 * own numeric/string ambiguity. */
export function authErrorCode(envelope: WyzeAuthEnvelope): string {
  return normalizeCode(envelope.raw["errorCode"]);
}

/** `description` — the auth host's analogue of the device host's `msg`
 * (see this module's header comment for the source-reading that
 * establishes the analogy) — REUSES normalizeMsg()'s undefined/null-safe
 * stringify rather than writing a near-duplicate. */
export function authErrorDescription(envelope: WyzeAuthEnvelope): string {
  return normalizeMsg(envelope.raw["description"]);
}

/** `requestId` — the auth host's correlation id (the device host's is
 * `traceId`, a different field name — see the ticket's structural fact
 * 2). Server-generated, not derived from anything in the request body, so
 * safe to surface in an error message (see wyze-errors.ts's "report
 * position, never content" rule). */
export function authRequestId(envelope: WyzeAuthEnvelope): string | undefined {
  const value = envelope.raw["requestId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `errorCode === 1000` — see src/wyze-errors.ts's
 * wyzeInvalidCredentialsOrSsoOnlyError() for why this single code covers
 * both a wrong password AND an SSO-only account. MEASURED (this is the
 * exact code this ticket's reproduction observed). */
export function isAuthInvalidCredentialsCode(envelope: WyzeAuthEnvelope): boolean {
  return isAuthErrorEnvelope(envelope) && authErrorCode(envelope) === "1000";
}

/** A non-empty top-level `access_token` string — see this module's header
 * comment for why success is read from `raw` directly rather than a
 * nested `data`. In every real transcript this ticket captured or the
 * community SDK's source describes, the error/success/MFA shapes are
 * mutually exclusive, so callers check this independently rather than as
 * an else-branch of error detection. */
export function isAuthSuccessEnvelope(envelope: WyzeAuthEnvelope): boolean {
  const token = envelope.raw["access_token"];
  return typeof token === "string" && token.length > 0;
}

/**
 * Mirrors wyze-envelope.ts's detectMfaChallenge() — same
 * checked-independently-of-error/success-shape discipline, since neither
 * the finding nor the source read pins down a `code`/`errorCode` value
 * that accompanies a challenge — but reads the auth host's OWN inferred
 * field layout (see this module's header comment), not the device host's.
 *
 * Only TOTP challenges are ever actually answered (see
 * src/auth-session.ts) — SMS and UNKNOWN both throw before a
 * verificationId is ever read (wyze-errors.ts's
 * wyzeMfaSmsUnsupportedError()/wyzeMfaUnknownTypeError()), so this
 * function only refuses to detect a challenge (returns undefined) when it
 * cannot resolve a TOTP verification id; an unresolvable SMS/unknown id
 * still classifies, since its value is never consumed.
 */
export function detectAuthMfaChallenge(envelope: WyzeAuthEnvelope): MfaChallenge | undefined {
  const options = envelope.raw["mfa_options"];
  if (!Array.isArray(options) || options.length === 0) {
    return undefined;
  }

  const normalizedOptions = options.map((o) => String(o).toLowerCase());
  const isTotp = normalizedOptions.some((o) => o.includes("totp"));
  const isSms = !isTotp && normalizedOptions.some((o) => o.includes("phone") || o.includes("sms"));
  const mfaType: MfaChallenge["mfaType"] = isTotp ? "TOTP" : isSms ? "SMS" : "UNKNOWN";

  if (mfaType === "TOTP") {
    const verificationId = totpVerificationId(envelope);
    return verificationId ? { mfaType, verificationId } : undefined;
  }

  // Never answered automatically — the placeholder verificationId below
  // is never read by any caller (see the doc comment above).
  return { mfaType, verificationId: smsVerificationId(envelope) ?? "unused-not-answered" };
}

function totpVerificationId(envelope: WyzeAuthEnvelope): string | undefined {
  const details = envelope.raw["mfa_details"];
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const apps = (details as Record<string, unknown>)["totp_apps"];
  if (!Array.isArray(apps) || apps.length === 0) {
    return undefined;
  }
  const first = apps[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const appId = (first as Record<string, unknown>)["app_id"];
  return typeof appId === "string" && appId.length > 0 ? appId : undefined;
}

function smsVerificationId(envelope: WyzeAuthEnvelope): string | undefined {
  const value = envelope.raw["sms_session_id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extracts access_token/refresh_token from a successful auth-host
 * response's TOP LEVEL (see this module's header comment) — the
 * auth-host counterpart of wyze-envelope.ts's extractTokens(). Throws a
 * plain Error (callers wrap it) if either is missing or not a string. */
export function extractAuthTokens(envelope: WyzeAuthEnvelope): { accessToken: string; refreshToken: string } {
  const accessToken = envelope.raw["access_token"];
  const refreshToken = envelope.raw["refresh_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Wyze auth response was successful but had no access_token.");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Wyze auth response was successful but had no refresh_token.");
  }
  return { accessToken, refreshToken };
}
