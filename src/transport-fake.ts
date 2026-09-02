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
  LoginRequest,
  RefreshTokenRequest,
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

/** SYNTHETIC. A minimal, clearly-placeholder device list — the exact
 * field set is docs/wyze-api-findings-2026-09-02.md's explicit unknown #1
 * (no captured real `get_object_list` payload exists in any (a)/(b)-tier
 * source). This exists so the interface has something to call and the
 * next task (`wyzr devices list`, out of THIS task's scope) has a fake to
 * develop against — it is a placeholder, not a verified contract. */
export function fakeGetObjectListEnvelope(): WyzeEnvelope {
  return {
    code: "1",
    msg: "",
    data: {
      device_list: [
        {
          mac: "FAKE0000MAC0",
          product_model: "WLPP1",
          nickname: "fake synthetic plug — not a real device",
          device_params: {},
        },
      ],
    },
  };
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
}
