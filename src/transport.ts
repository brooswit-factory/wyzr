// The single injectable boundary everything that talks to Wyze goes
// through — src/transport-http.ts (real HTTP) and src/transport-fake.ts
// (synthetic canned responses) both implement this interface, and
// src/auth-session.ts is written against the interface only, never against
// either implementation directly. That is what makes the auth/MFA/refresh
// logic in auth-session.ts testable with zero network and zero credentials.
//
// Hosts and endpoints below are from docs/wyze-api-findings-2026-09-02.md
// §Q3/§Q4 (tier (b), read from the actively-maintained `wyze-sdk`'s own
// source) — verify against that document, not against this comment, if the
// two ever seem to disagree.

import type { WyzeEnvelope } from "./wyze-envelope.ts";

export const WYZE_AUTH_HOST = "auth-prod.api.wyze.com";
export const WYZE_API_HOST = "api.wyzecam.com";

export const WYZE_LOGIN_PATH = "/api/user/login";
export const WYZE_REFRESH_TOKEN_PATH = "/app/user/refresh_token";
export const WYZE_GET_OBJECT_LIST_PATH = "/app/v2/home_page/get_object_list";
export const WYZE_GET_PROPERTY_LIST_PATH = "/app/v2/device/get_property_list";
export const WYZE_SET_PROPERTY_PATH = "/app/v2/device/set_property";

export interface LoginRequest {
  email: string;
  /** Already `md5(md5(md5(password)))` — see src/wyze-auth-hash.ts.
   * This interface never sees a raw password. */
  passwordHash: string;
  nonce: string;
  keyId: string;
  keySecret: string;
}

export interface SubmitMfaRequest {
  email: string;
  passwordHash: string;
  nonce: string;
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

/** WYZR-13's addition. `value` is deliberately typed `0 | 1`, never
 * `boolean` — decision (A): `P3` is wire-encoded as an integer, and this
 * type is one of the two places (the other is decodeP3() in src/plug.ts)
 * that makes sending a native boolean a compile error, not just a runtime
 * mistake to catch in review. */
export interface SetPropertyRequest {
  accessToken: string;
  mac: string;
  model: string;
  pid: string;
  value: 0 | 1;
}

/**
 * Everything that talks to Wyze. Every method resolves to the RAW envelope
 * — success/error/MFA-challenge interpretation is deliberately NOT this
 * interface's job (see src/wyze-envelope.ts): keeping that logic transport-
 * agnostic means it is unit-tested once, identically, regardless of which
 * implementation produced the envelope.
 */
export interface WyzeTransport {
  login(req: LoginRequest): Promise<WyzeEnvelope>;
  submitMfa(req: SubmitMfaRequest): Promise<WyzeEnvelope>;
  refreshToken(req: RefreshTokenRequest): Promise<WyzeEnvelope>;
  getObjectList(req: GetObjectListRequest): Promise<WyzeEnvelope>;
  getPropertyList(req: GetPropertyListRequest): Promise<WyzeEnvelope>;
  setProperty(req: SetPropertyRequest): Promise<WyzeEnvelope>;
}
