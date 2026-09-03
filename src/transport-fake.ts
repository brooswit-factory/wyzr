// A first-class fake implementation of WyzeTransport (src/transport.ts),
// shipped alongside the real one, for exercising every code path with NO
// network and NO real Wyze account.
//
// *** EVERY RESPONSE BELOW IS SYNTHETIC. NONE IS A CAPTURE OF REAL WYZE
// TRAFFIC. *** docs/wyze-api-findings-2026-09-02.md's explicit unknown #1
// is that no captured example of a real Wyze response payload was found in
// any (a)/(b)-tier source; these canned envelopes are constructed from the
// finding's description of the envelope shape and the community SDK's
// parsing code, never observed. Do not treat a green test against this
// fake as evidence about the real API's behavior (see the ticket and
// README's "Live-device coverage" section) — it only proves this repo's
// code matches this repo's own belief about the shape.
//
// Default behavior on each method is a plain success; pass a handler
// override to simulate an MFA challenge, an errorCode 1000, an expired
// access token, or anything else a test needs.

import type {
  GetObjectListRequest,
  GetPropertyListRequest,
  LoginRequest,
  RefreshTokenRequest,
  SetPropertyRequest,
  SubmitMfaRequest,
  WyzeTransport,
} from "./transport.ts";
import type { WyzeEnvelope } from "./wyze-envelope.ts";

export type Handler<Req> = (req: Req) => WyzeEnvelope | Promise<WyzeEnvelope>;

export interface FakeWyzeTransportOptions {
  loginHandler?: Handler<LoginRequest>;
  submitMfaHandler?: Handler<SubmitMfaRequest>;
  refreshTokenHandler?: Handler<RefreshTokenRequest>;
  getObjectListHandler?: Handler<GetObjectListRequest>;
  getPropertyListHandler?: Handler<GetPropertyListRequest>;
  setPropertyHandler?: Handler<SetPropertyRequest>;
}

/** SYNTHETIC. A fake but plausibly-shaped access/refresh token pair —
 * obviously fake strings, never mistakable for a real Wyze token. */
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

/** SYNTHETIC. errorCode 1000 — see src/wyze-errors.ts for why this single
 * code covers both a wrong password AND an SSO-only account. */
export function fakeInvalidCredentialsEnvelope(): WyzeEnvelope {
  return { code: 1000, msg: "wrong password or apikey", data: {} };
}

/** SYNTHETIC. code 2001 — the access token has expired. */
export function fakeAccessTokenExpiredEnvelope(): WyzeEnvelope {
  return { code: 2001, msg: "AccessTokenError", data: {} };
}

/** SYNTHETIC. An MFA challenge shaped per src/wyze-envelope.ts's
 * detectMfaChallenge() — field names are this project's own inference
 * (tier (d)), not a captured real payload; see that function's comment. */
export function fakeMfaTotpChallengeEnvelope(verificationId = "fake-verification-id-totp-000"): WyzeEnvelope {
  return {
    code: "90955",
    msg: "MfaRequired",
    data: { mfa_options: ["TotpVerificationCode"], verification_id: verificationId },
  };
}

/** SYNTHETIC. Same shape as the TOTP challenge, but an SMS-only option. */
export function fakeMfaSmsChallengeEnvelope(verificationId = "fake-verification-id-sms-000"): WyzeEnvelope {
  return {
    code: "90955",
    msg: "MfaRequired",
    data: { mfa_options: ["PrimaryPhone"], verification_id: verificationId },
  };
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

/** SYNTHETIC. A minimal, clearly-placeholder device list — the exact
 * field set is docs/wyze-api-findings-2026-09-02.md's explicit unknown #1
 * (no captured real `get_object_list` payload exists in any (a)/(b)-tier
 * source). Defaults to one device (matching this fixture's original,
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

/** SYNTHETIC. A `get_property_list` response shaped as this project infers
 * it (a `property_list` array of `{pid, value}` entries inside `data` — see
 * src/plug.ts's top comment for why). Defaults to a plug that is ON and
 * REACHABLE (`P3: 1, P5: 1`); pass `props` to simulate off, unreachable,
 * a missing pid, or a wire-type WYZR-13's own tests need to reject (e.g.
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

/** SYNTHETIC. A `set_property` success response. The finding documents no
 * particular `data` shape for this call; `wyzr` never reads anything out of
 * a `set_property` response body itself — decision (D) always follows it
 * with a separate `get_property_list` read-back instead of trusting this
 * envelope's `data`. */
export function fakeSetPropertyEnvelope(): WyzeEnvelope {
  return { code: "1", msg: "", data: {} };
}

export class FakeWyzeTransport implements WyzeTransport {
  constructor(private readonly opts: FakeWyzeTransportOptions = {}) {}

  async login(req: LoginRequest): Promise<WyzeEnvelope> {
    return this.opts.loginHandler ? await this.opts.loginHandler(req) : fakeSuccessEnvelope();
  }

  async submitMfa(req: SubmitMfaRequest): Promise<WyzeEnvelope> {
    return this.opts.submitMfaHandler ? await this.opts.submitMfaHandler(req) : fakeSuccessEnvelope();
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
