// The real implementation of WyzeTransport (src/transport.ts): performs
// actual HTTP calls against Wyze's hosts. Its HTTP-performing function is
// INJECTABLE (`fetchImpl`, defaulting to the global `fetch`) so its request
// construction and response handling can be unit-tested with NO network —
// see test/unit/transport-http.test.ts, which never lets the default apply.
//
// NO automatic retry anywhere in this file, on any endpoint — the finding
// (docs/wyze-api-findings-2026-09-02.md §Q5) names login-endpoint rate
// limiting as a specific hazard, and a retry loop is exactly the wrong
// reflex there; refresh-and-retry-once on an expired access token is
// handled one layer up, in src/auth-session.ts, not here.

import { APP_IDENTITY_KEY } from "./app-identity.ts";
import { CliError, ExitCode } from "./errors.ts";
import { registerSecret } from "./redact.ts";
import type {
  GetObjectListRequest,
  LoginRequest,
  RefreshTokenRequest,
  SubmitMfaRequest,
  WyzeTransport,
} from "./transport.ts";
import {
  WYZE_API_HOST,
  WYZE_AUTH_HOST,
  WYZE_GET_OBJECT_LIST_PATH,
  WYZE_LOGIN_PATH,
  WYZE_REFRESH_TOKEN_PATH,
} from "./transport.ts";
import type { WyzeEnvelope } from "./wyze-envelope.ts";

export type FetchLike = typeof fetch;

export interface RealWyzeTransportOptions {
  /** Injected HTTP-performing function, `fetch`-shaped. Defaults to the
   * global `fetch` — this repo's own test suite never relies on that
   * default, so no test in this repo opens a socket. */
  fetchImpl?: FetchLike;
}

export class RealWyzeTransport implements WyzeTransport {
  private readonly fetchImpl: FetchLike;

  constructor(opts: RealWyzeTransportOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async login(req: LoginRequest): Promise<WyzeEnvelope> {
    return this.post(`https://${WYZE_AUTH_HOST}${WYZE_LOGIN_PATH}`, {
      email: req.email,
      password: req.passwordHash,
      nonce: req.nonce,
      keyid: req.keyId,
      apikey: req.keySecret,
    });
  }

  async submitMfa(req: SubmitMfaRequest): Promise<WyzeEnvelope> {
    // Best-effort inference (tier (d)) — see detectMfaChallenge()'s comment
    // in src/wyze-envelope.ts for the same caveat. The finding documents
    // that an MFA challenge can occur, not the shape of the endpoint/body
    // that answers one; this re-POSTs to the login endpoint with the
    // challenge answer layered on top of the same login fields, the
    // common pattern for reverse-engineered mobile-app auth. Expect this
    // to need correction once a real account exercises it.
    return this.post(`https://${WYZE_AUTH_HOST}${WYZE_LOGIN_PATH}`, {
      email: req.email,
      password: req.passwordHash,
      nonce: req.nonce,
      keyid: req.keyId,
      apikey: req.keySecret,
      mfa_type: req.mfaType,
      verification_id: req.verificationId,
      verification_code: req.verificationCode,
    });
  }

  async refreshToken(req: RefreshTokenRequest): Promise<WyzeEnvelope> {
    return this.post(`https://${WYZE_API_HOST}${WYZE_REFRESH_TOKEN_PATH}`, {
      refresh_token: req.refreshToken,
      keyid: req.keyId,
      apikey: req.keySecret,
    });
  }

  async getObjectList(req: GetObjectListRequest): Promise<WyzeEnvelope> {
    // access_token carried in the JSON body, not an Authorization header —
    // an inference (tier (d), the finding does not pin this down), but one
    // corroborated by src/redact.ts already scrubbing a JSON
    // `"access_token"` field (added by WYZR-4's scaffold, before this
    // transport existed) — a signal that a token showing up as a body
    // field, not a header, was the anticipated shape.
    return this.post(`https://${WYZE_API_HOST}${WYZE_GET_OBJECT_LIST_PATH}`, {
      access_token: req.accessToken,
    });
  }

  private async post(url: string, body: Record<string, unknown>): Promise<WyzeEnvelope> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": APP_IDENTITY_KEY,
      },
      body: JSON.stringify(body),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CliError(
        `Wyze API at ${url} returned a non-JSON response (HTTP ${response.status}).`,
        ExitCode.Network,
        "wyze_non_json_response",
      );
    }

    return toEnvelope(parsed);
  }
}

/**
 * Normalizes an arbitrary parsed JSON value into a WyzeEnvelope, and
 * registers any `access_token`/`refresh_token` string found in it for
 * redaction IMMEDIATELY — before this function returns to ANY caller, and
 * therefore before anything downstream has a chance to print it.
 * Deliberately unconditional: it does not first check whether the envelope
 * "looks successful," because the finding warns reverse-engineered APIs
 * "routinely include tokens and account identifiers" beyond what was
 * asked for — an error-shaped response could still carry a token-shaped
 * field, and this registration must not depend on reaching a happy path.
 */
function toEnvelope(parsed: unknown): WyzeEnvelope {
  const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const data = obj["data"];
  registerAnyTokenFields(obj);
  registerAnyTokenFields(data);
  return { code: obj["code"], msg: obj["msg"], data };
}

function registerAnyTokenFields(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const obj = value as Record<string, unknown>;
  const accessToken = obj["access_token"];
  const refreshToken = obj["refresh_token"];
  if (typeof accessToken === "string") registerSecret(accessToken);
  if (typeof refreshToken === "string") registerSecret(refreshToken);
}
