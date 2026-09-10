// The single injectable boundary everything that talks to Wyze goes
// through — src/transport-http.ts (real HTTP) and src/transport-fake.ts
// (synthetic canned responses) both implement this interface, and
// src/auth-session.ts is written against the interface only, never against
// either implementation directly. That is what makes the auth/MFA/refresh
// logic in auth-session.ts testable with zero network and zero credentials.
//
// Hosts and endpoints below were originally read from
// docs/wyze-api-findings-2026-09-02.md §Q3/§Q4 (tier (b), the
// actively-maintained `wyze-sdk`'s own source) and are now also confirmed
// by WYZR-15's live-account measurement (RELAYED, not observed directly by
// this repo's own authors — see src/transport-http.ts's header comment for
// what that means and src/wyze-device-identity.ts for the request-shape
// decisions the same measurement forced) — verify against that document,
// not against this comment, if the two ever seem to disagree.

import type { WyzeAuthEnvelope } from "./wyze-auth-envelope.ts";
import type { WyzeEnvelope } from "./wyze-envelope.ts";

export const WYZE_AUTH_HOST = "auth-prod.api.wyze.com";
export const WYZE_API_HOST = "api.wyzecam.com";

export const WYZE_LOGIN_PATH = "/api/user/login";
export const WYZE_REFRESH_TOKEN_PATH = "/app/user/refresh_token";
export const WYZE_GET_OBJECT_LIST_PATH = "/app/v2/home_page/get_object_list";
export const WYZE_GET_PROPERTY_LIST_PATH = "/app/v2/device/get_property_list";
export const WYZE_SET_PROPERTY_PATH = "/app/v2/device/set_property";

/** No `nonce` field — WYZR-15's live-account measurement (RELAYED; see
 * src/transport-http.ts's header comment) showed the working login body is
 * exactly `{email, password}`, nothing else. This project's earlier,
 * never-confirmed guess that a nonce was required (and its own default
 * generator) is retired along with it — see AuthSessionDeps in
 * src/auth-session.ts, which no longer has a `nonce` dependency either. */
export interface LoginRequest {
  email: string;
  /** Already `md5(md5(md5(password)))` — see src/wyze-auth-hash.ts.
   * This interface never sees a raw password. */
  passwordHash: string;
  keyId: string;
  keySecret: string;
}

/** Same no-`nonce` change as LoginRequest, for the same reason — but note
 * the MFA-answer endpoint/body shape itself remains UNOBSERVED by anyone
 * (tier (d)); see src/transport-http.ts's submitMfa() comment for the
 * reasoning behind mirroring login's now-measured minimalism here anyway. */
export interface SubmitMfaRequest {
  email: string;
  passwordHash: string;
  keyId: string;
  keySecret: string;
  verificationId: string;
  mfaType: "TOTP" | "SMS";
  verificationCode: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
  keyId: string;
  keySecret: string;
}

export interface GetObjectListRequest {
  accessToken: string;
}

/** WYZR-13's addition. `targetPids` is the finding's §Q4 "you ask for
 * specific property IDs; there is no generic 'status' field" — `mac`/
 * `model` pair with it, per the same table. */
export interface GetPropertyListRequest {
  accessToken: string;
  mac: string;
  model: string;
  targetPids: string[];
}

/** WYZR-13's addition, REVISED by WYZR-15: `value` is deliberately typed
 * `"0" | "1"`, a STRING literal union, never `boolean` AND never a bare
 * number. Decision (A) originally believed `P3` was wire-encoded as an
 * integer (tier (b), from the community SDK's own type declaration);
 * WYZR-15's live-account measurement (RELAYED — see
 * src/transport-http.ts's header comment) showed `set_property`'s actual
 * wire value is the STRING `"1"`/`"0"` — decision (A) is REVISED, not
 * merely corrected in one spot: this type is one of the two places (the
 * other is decodeP3() in src/plug.ts, which already tolerated strings
 * defensively) that makes sending the WRONG wire type a compile error,
 * not just a runtime mistake to catch in review — flipped from "reject a
 * boolean, allow a number" to "reject a boolean, reject a bare number,
 * allow only the confirmed string values." */
export interface SetPropertyRequest {
  accessToken: string;
  mac: string;
  model: string;
  pid: string;
  value: "0" | "1";
}

/**
 * Everything that talks to Wyze. Every method resolves to the RAW envelope
 * — success/error/MFA-challenge interpretation is deliberately NOT this
 * interface's job (see src/wyze-envelope.ts / src/wyze-auth-envelope.ts):
 * keeping that logic transport-agnostic means it is unit-tested once,
 * identically, regardless of which implementation produced the envelope.
 *
 * `login`/`submitMfa` hit the AUTH host (auth-prod.api.wyze.com) and
 * resolve to `WyzeAuthEnvelope` — its OWN envelope family
 * (src/wyze-auth-envelope.ts), separate from the other four methods below,
 * which hit the DEVICE host (api.wyzecam.com, including `refreshToken` —
 * see WYZE_REFRESH_TOKEN_PATH above) and resolve to the device host's
 * `WyzeEnvelope` (src/wyze-envelope.ts). WYZR-15 split this from one
 * shared envelope type after measuring that the two hosts do not share a
 * response shape at all — see wyze-envelope.ts's header comment.
 */
export interface WyzeTransport {
  login(req: LoginRequest): Promise<WyzeAuthEnvelope>;
  submitMfa(req: SubmitMfaRequest): Promise<WyzeAuthEnvelope>;
  refreshToken(req: RefreshTokenRequest): Promise<WyzeEnvelope>;
  getObjectList(req: GetObjectListRequest): Promise<WyzeEnvelope>;
  getPropertyList(req: GetPropertyListRequest): Promise<WyzeEnvelope>;
  setProperty(req: SetPropertyRequest): Promise<WyzeEnvelope>;
}
