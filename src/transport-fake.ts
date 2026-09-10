// A first-class fake implementation of WyzeTransport (src/transport.ts),
// shipped alongside the real one, for exercising every code path with NO
// network and NO real Wyze account.
//
// PROVENANCE TAGGING (WYZR-15, criterion 7): every fixture function below
// is tagged, in its own doc comment, with exactly one of:
//   PROVENANCE: CAPTURED-LIVE, placeholder-credential probe, 2026-09-10,
//     observed twice independently — built from THIS PROJECT'S OWN
//     reproduction of a real Wyze response against a placeholder-
//     credentialed request (see the PR body for the raw transcript). Any
//     one-time field (a request/trace id) is replaced with a fixed
//     placeholder — everything else is verbatim.
//   PROVENANCE: RELAYED, assistant, live account, 2026-09-10, RELAYED —
//     NOT OBSERVED BY THIS REPO'S AUTHORS — built from a shape measured
//     by a DIFFERENT assistant against a REAL, human-provisioned account
//     on a separate box, relayed assistant -> project -> epic -> this
//     ticket -> this file (four hops). Nobody who wrote this file
//     observed it directly. See src/transport-http.ts's header comment
//     for the full chain and why a transcription error at any hop is a
//     live risk this tagging exists to bound.
//   PROVENANCE: ASSUMED (tier (d)[, corroborated tier (b) by ...]) — no
//     real response of this shape has ever been observed, by anyone, at
//     any tier; built from the finding's description and/or a
//     community-SDK source read.
// `grep -rn "PROVENANCE: ASSUMED" src/` finds every belief in this repo
// that has never been checked against the real API — that is this
// criterion's whole point: greppable, not remembered. This replaces the
// earlier "SYNTHETIC." wording, which said "not real" but not WHY it
// isn't, whether it could be checked cheaply (several of these turned out
// to be, with zero credentials), or whether it already HAS been checked by
// someone else, just not this repo's own authors (the RELAYED case).
//
// Do not treat a green test against an ASSUMED or RELAYED fixture as
// first-hand evidence about the real API's behavior (see README's
// "Live-device coverage" section) — ASSUMED means nobody has ever checked;
// RELAYED means someone else did, once, and this repo did not verify it
// directly (see the epistemic-status warning on this ticket).
//
// Default behavior on each method is a plain success; pass a handler
// override to simulate an MFA challenge, an errorCode/code error, an
// expired access token, or anything else a test needs.

import type {
  GetObjectListRequest,
  GetPropertyListRequest,
  LoginRequest,
  RefreshTokenRequest,
  SetPropertyRequest,
  SubmitMfaRequest,
  WyzeTransport,
} from "./transport.ts";
import type { WyzeAuthEnvelope } from "./wyze-auth-envelope.ts";
import type { WyzeEnvelope } from "./wyze-envelope.ts";

export type Handler<Req, Env> = (req: Req) => Env | Promise<Env>;

export interface FakeWyzeTransportOptions {
  loginHandler?: Handler<LoginRequest, WyzeAuthEnvelope>;
  submitMfaHandler?: Handler<SubmitMfaRequest, WyzeAuthEnvelope>;
  refreshTokenHandler?: Handler<RefreshTokenRequest, WyzeEnvelope>;
  getObjectListHandler?: Handler<GetObjectListRequest, WyzeEnvelope>;
  getPropertyListHandler?: Handler<GetPropertyListRequest, WyzeEnvelope>;
  setPropertyHandler?: Handler<SetPropertyRequest, WyzeEnvelope>;
}

// === AUTH-HOST fixtures (login()/submitMfa()) — WyzeAuthEnvelope ===

/** PROVENANCE: RELAYED, assistant, live account, 2026-09-10, RELAYED — NOT
 * OBSERVED BY THIS REPO'S AUTHORS (see this file's header comment for what
 * that means). This project's own authors have never observed a
 * successful Wyze login — no account exists here and none will be
 * created. The SHAPE (tokens at the TOP LEVEL of `raw`, not nested under a
 * `data` key — distinct from the device host's fakeSuccessEnvelope()
 * below — plus `user_id`, and `mfa_options`/`mfa_details`/
 * `sms_session_id`/`email_session_id` all present but `null` on the
 * measured account) is exactly the relayed transcript; the actual TOKEN
 * VALUES below are this project's own obviously-fake placeholders, never
 * mistakable for a real Wyze token. */
export function fakeAuthSuccessEnvelope(
  overrides: Partial<{ accessToken: string; refreshToken: string }> = {},
): WyzeAuthEnvelope {
  return {
    httpStatus: 200,
    raw: {
      access_token: overrides.accessToken ?? "FAKE-auth-access-token-not-real-000",
      refresh_token: overrides.refreshToken ?? "FAKE-auth-refresh-token-not-real-000",
      user_id: "fake-user-id-000",
      mfa_options: null,
      mfa_details: null,
      sms_session_id: null,
      email_session_id: null,
    },
  };
}

/** PROVENANCE: CAPTURED-LIVE, placeholder-credential probe, 2026-09-10,
 * observed twice independently before this ticket existed (two agents, two
 * hosts, two Atlassian identities) and reproduced a third time as this
 * ticket's own first action, plus swept across a missing-field and a
 * bad-keyid variant (same shape, different errorCode — see the PR body for
 * every raw transcript). HTTP 400. `requestId` is a one-time id per real
 * call; the value below is a fixed placeholder, everything else is
 * verbatim. NOTE (WYZR-15's second correction): this exact response was
 * reached through wyzr's OWN then-malformed login request (keyid/apikey in
 * the body, not headers) — it remains a true, directly-observed capture of
 * this HOST's error SHAPE for a request it rejects, but is no longer
 * assumed to be what a well-formed login sees; do not call it "the
 * canonical auth error" anywhere. errorCode 1000 covers a wrong password,
 * an SSO-only account with no Wyze-native password, OR a request the host
 * could not read the login key from at all — see
 * src/wyze-errors.ts's wyzeInvalidCredentialsOrSsoOnlyError(). */
export function fakeAuthInvalidCredentialsEnvelope(): WyzeAuthEnvelope {
  return {
    httpStatus: 400,
    raw: {
      description: "Invalid credentials, please check username, password, keyid or apikey",
      requestId: "fake-request-id-000",
      errorCode: 1000,
    },
  };
}

/** PROVENANCE: ASSUMED (tier (d), corroborated tier (b) by a community-SDK
 * source read — see src/wyze-auth-envelope.ts's header comment). STILL
 * UNOBSERVED BY ANYONE, not just this repo: the one live-account login
 * this epic has ever relayed a transcript for did NOT trigger MFA —
 * `mfa_options`/`mfa_details` came back `null` on that account (see
 * fakeAuthSuccessEnvelope() above) — so this shape remains exactly as
 * unconfirmed as before, however much more confident the surrounding
 * shapes now are. Do not read the relay as strengthening this one.
 * `mfa_details.totp_apps[0].app_id` is the auth host's own inferred TOTP
 * verification-id path — see src/wyze-auth-envelope.ts's
 * detectAuthMfaChallenge(). */
export function fakeAuthMfaTotpChallengeEnvelope(appId = "fake-totp-app-id-000"): WyzeAuthEnvelope {
  return {
    httpStatus: 200,
    raw: { mfa_options: ["TotpVerificationCode"], mfa_details: { totp_apps: [{ app_id: appId }] } },
  };
}

/** PROVENANCE: ASSUMED (tier (d), corroborated tier (b) by the same
 * source read) — STILL UNOBSERVED BY ANYONE, same caveat as
 * fakeAuthMfaTotpChallengeEnvelope() above. `sms_session_id` at the top
 * level. wyzr never answers an SMS challenge (see
 * src/wyze-errors.ts's wyzeMfaSmsUnsupportedError()), so this fixture
 * exists only to prove that refusal, not a real answer flow. */
export function fakeAuthMfaSmsChallengeEnvelope(sessionId = "fake-sms-session-id-000"): WyzeAuthEnvelope {
  return { httpStatus: 200, raw: { mfa_options: ["PrimaryPhone"], sms_session_id: sessionId } };
}

// === DEVICE-HOST fixtures (refreshToken/getObjectList/getPropertyList/
// setProperty) — WyzeEnvelope. The {code,msg,data} ENVELOPE SHAPE is
// unchanged by WYZR-15 (measured correct twice — see
// src/wyze-envelope.ts's header comment); the REQUEST shapes that produce
// these responses DID change (src/wyze-device-identity.ts's standard body;
// device_mac/device_model/pvalue field names) — these fixtures model the
// RESPONSE side only, which was already right. ===

/** PROVENANCE: ASSUMED (tier (d)) for the `access_token`/`refresh_token`
 * VALUES (obviously-fake strings, never mistakable for a real Wyze
 * token); the {code,msg,data} SHAPE itself is tier (a) — see
 * src/wyze-envelope.ts's header comment for this ticket's own live
 * device-host measurement. Used for refreshToken()'s success response
 * (device host) — login()/submitMfa() use fakeAuthSuccessEnvelope()
 * above instead. */
export function fakeSuccessEnvelope(overrides: Partial<{ accessToken: string; refreshToken: string }> = {}): WyzeEnvelope {
  return {
    code: "1",
    msg: "",
    data: {
      access_token: overrides.accessToken ?? "FAKE-access-token-not-real-000",
      refresh_token: overrides.refreshToken ?? "FAKE-refresh-token-not-real-000",
      user_id: "fake-user-id-000",
    },
  };
}

/** PROVENANCE: ASSUMED (tier (d)) for `code: 1000` specifically meaning
 * "invalid credentials" on THIS host — no device-host response has ever
 * been observed to carry that particular code (this ticket's own live
 * device-host measurement returned `code: "1001"` for a bad request
 * instead; see src/wyze-envelope.ts's header comment). The {code,msg,data}
 * SHAPE is tier (a). Kept for refreshToken() failure scenarios (device
 * host) — login()/submitMfa() use fakeAuthInvalidCredentialsEnvelope()
 * above instead, which IS a captured-live auth-host response. */
export function fakeInvalidCredentialsEnvelope(): WyzeEnvelope {
  return { code: 1000, msg: "wrong password or apikey", data: {} };
}

/** PROVENANCE: ASSUMED (tier (d)) for `code: 2001` specifically; the
 * {code,msg,data} SHAPE is tier (a) (see above). */
export function fakeAccessTokenExpiredEnvelope(): WyzeEnvelope {
  return { code: 2001, msg: "AccessTokenError", data: {} };
}

/** One device entry's overridable fields for fakeGetObjectListEnvelope()
 * below. `connState` omitted entirely (the default) reproduces WYZR-6's
 * original fixture gap on purpose — src/devices.ts's classifyState() then
 * reads `"unknown"`, exactly as it would for a real response missing the
 * field this project only guesses at. Pass `1`/`0` to get a device that
 * projects as online/offline instead. */
export interface FakeDeviceListEntry {
  mac?: string;
  model?: string;
  nickname?: string;
  connState?: 0 | 1 | "0" | "1";
}

/** Convenience presets — WYZR-13's fixture-enrichment requirement: "a fake
 * that can express a genuinely ONLINE plug, an OFFLINE one, and an UNKNOWN
 * one." Spread one of these into fakeGetObjectListEnvelope()'s device
 * overrides, e.g. `fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac:
 * "..." }])`. */
export const FAKE_PLUG_ONLINE: FakeDeviceListEntry = { connState: 1 };
export const FAKE_PLUG_OFFLINE: FakeDeviceListEntry = { connState: 0 };
export const FAKE_PLUG_STATE_UNKNOWN: FakeDeviceListEntry = {};

/** PROVENANCE: field NAMES (`nickname`, `product_model`, `mac`,
 * `conn_state`) are RELAYED, assistant, live account, 2026-09-10, RELAYED
 * — NOT OBSERVED BY THIS REPO'S AUTHORS (see this file's header comment):
 * a real `get_object_list` response carried exactly these field names,
 * across 16 real devices, plus a `product_type` field this project does
 * not currently project (src/devices.ts's allowlist simply omits it — not
 * an error; see that module's own comment). Every other detail — the
 * VALUES, that there is only one device, `device_params` existing at all —
 * is this project's own ASSUMED placeholder, not part of the relayed
 * transcript. Defaults to one device (matching this fixture's original,
 * single-device shape from WYZR-6/WYZR-11) with no `conn_state` at all;
 * pass an array of `FakeDeviceListEntry` to control however many devices,
 * and each one's mac/model/nickname/online-offline-unknown state, a test
 * needs — this is WYZR-13's fix for the gap named on the ticket: WYZR-6's
 * original fixture could only ever express "unknown," which meant nothing
 * in this repo could exercise the online/offline distinction this story's
 * `plug status`/`plug on`/`plug off` depend on. */
export function fakeGetObjectListEnvelope(devices: FakeDeviceListEntry[] = [{}]): WyzeEnvelope {
  return {
    code: "1",
    msg: "",
    data: {
      device_list: devices.map((entry, index) => {
        const device: Record<string, unknown> = {
          mac: entry.mac ?? `FAKE0000MAC${index}`,
          product_model: entry.model ?? "WLPP1",
          nickname: entry.nickname ?? "fake synthetic plug — not a real device",
          device_params: {},
        };
        if (entry.connState !== undefined) {
          device["conn_state"] = entry.connState;
        }
        return device;
      }),
    },
  };
}

/** PROVENANCE: the SHAPE (`data.property_list` as a `{pid, value}` array)
 * AND the wire TYPE of `value` (a STRING, e.g. `"1"`, not a number) are
 * RELAYED, assistant, live account, 2026-09-10, RELAYED — NOT OBSERVED BY
 * THIS REPO'S AUTHORS (see this file's header comment) — a real
 * `get_property_list` read-back of P3/P5 on an actual plug confirmed
 * exactly this. This project's earlier belief (P3/P5 as wire INTEGERS,
 * from the community SDK's own internal Python typing) was WRONG; see
 * src/plug.ts's decision (A) for the full correction. The DEFAULT args
 * below (`{ P3: 1, P5: 1 }`, numbers) are left as this project's own
 * ASSUMED convenience default — decodeP3()/decodeP5() tolerate numbers
 * defensively — but a test asserting wire fidelity should pass STRING
 * props explicitly. Pass `props` to simulate off, unreachable, a missing
 * pid, or a wire-type WYZR-13's own tests need to reject (e.g.
 * `{ P3: true }` for the boolean-rejection red-first test). */
export function fakePropertyListEnvelope(props: Record<string, unknown> = { P3: 1, P5: 1 }): WyzeEnvelope {
  return {
    code: "1",
    msg: "",
    data: {
      property_list: Object.entries(props).map(([pid, value]) => ({ pid, value })),
    },
  };
}

/** PROVENANCE: `code: "1"` on success is RELAYED, assistant, live account,
 * 2026-09-10, RELAYED — NOT OBSERVED BY THIS REPO'S AUTHORS (see this
 * file's header comment): a real `set_property` write against an actual
 * plug returned `code "1", msg SUCCESS`, then a `get_property_list` read
 * three seconds later reflected the change. The empty `data: {}` here is
 * this project's own ASSUMED placeholder — `wyzr` never reads anything out
 * of a `set_property` response body itself, so its exact shape was never
 * relayed in detail; decision (D) always follows a write with a separate
 * `get_property_list` read-back instead of trusting this envelope's
 * `data`. */
export function fakeSetPropertyEnvelope(): WyzeEnvelope {
  return { code: "1", msg: "", data: {} };
}

export class FakeWyzeTransport implements WyzeTransport {
  constructor(private readonly opts: FakeWyzeTransportOptions = {}) {}

  async login(req: LoginRequest): Promise<WyzeAuthEnvelope> {
    return this.opts.loginHandler ? await this.opts.loginHandler(req) : fakeAuthSuccessEnvelope();
  }

  async submitMfa(req: SubmitMfaRequest): Promise<WyzeAuthEnvelope> {
    return this.opts.submitMfaHandler ? await this.opts.submitMfaHandler(req) : fakeAuthSuccessEnvelope();
  }

  async refreshToken(req: RefreshTokenRequest): Promise<WyzeEnvelope> {
    return this.opts.refreshTokenHandler ? await this.opts.refreshTokenHandler(req) : fakeSuccessEnvelope();
  }

  async getObjectList(req: GetObjectListRequest): Promise<WyzeEnvelope> {
    return this.opts.getObjectListHandler ? await this.opts.getObjectListHandler(req) : fakeGetObjectListEnvelope();
  }

  async getPropertyList(req: GetPropertyListRequest): Promise<WyzeEnvelope> {
    return this.opts.getPropertyListHandler
      ? await this.opts.getPropertyListHandler(req)
      : fakePropertyListEnvelope();
  }

  async setProperty(req: SetPropertyRequest): Promise<WyzeEnvelope> {
    return this.opts.setPropertyHandler ? await this.opts.setPropertyHandler(req) : fakeSetPropertyEnvelope();
  }
}
