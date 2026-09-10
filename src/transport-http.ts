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
//
// === WYZR-15: THE REQUEST SHAPES BELOW WERE CORRECTED AGAINST A REAL,
// LIVE-ACCOUNT MEASUREMENT — RELAYED, NOT OBSERVED DIRECTLY ===
//
// Everything in this file that is NOT one of the two placeholder-credential
// error envelopes (see src/wyze-auth-envelope.ts / src/wyze-envelope.ts's
// header comments — those WERE observed directly, twice, independently, by
// this project) reached this repo via a four-hop relay: a human provisioned
// real credentials on a separate "manager" box; an assistant there
// exercised every call this product makes against the live Wyze API with a
// real account and posted the results as Confluence comments; that was
// read by this epic's project-tier agent, then its story, then this task's
// own ticket, then this file. NOBODY WHO WROTE THIS FILE OBSERVED THESE
// SHAPES FIRST-HAND — this is a copy of a copy of a copy, and a
// transcription error at any hop would be silently wrong (which is this
// whole ticket's subject matter). Treat every request/response shape below
// as HIGH-CONFIDENCE (each was obtained by changing one thing at a time
// against a real, working account) but NOT tier (a): see each fixture's own
// PROVENANCE tag in src/transport-fake.ts for the precise wording, and
// docs/wyze-api-findings-2026-09-02.md §Q3 for the dated record.

import { CliError, ExitCode } from "./errors.ts";
import { registerSecret } from "./redact.ts";
import type {
  GetObjectListRequest,
  GetPropertyListRequest,
  LoginRequest,
  RefreshTokenRequest,
  SetPropertyRequest,
  SubmitMfaRequest,
  WyzeTransport,
} from "./transport.ts";
import {
  WYZE_API_HOST,
  WYZE_AUTH_HOST,
  WYZE_GET_OBJECT_LIST_PATH,
  WYZE_GET_PROPERTY_LIST_PATH,
  WYZE_LOGIN_PATH,
  WYZE_REFRESH_TOKEN_PATH,
  WYZE_SET_PROPERTY_PATH,
} from "./transport.ts";
import type { WyzeAuthEnvelope } from "./wyze-auth-envelope.ts";
import { deviceStandardBody } from "./wyze-device-identity.ts";
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

  /** `keyid`/`apikey` are HEADERS, not body fields (corrected from the
   * pre-WYZR-15 shape, which sent them in the body and additionally sent a
   * now-retired `x-api-key` app-identity header — see
   * src/wyze-device-identity.ts's header comment for why that header is
   * gone rather than migrated). The body carries `email` and the
   * triple-MD5 `password` AND NOTHING ELSE — no `nonce` (see
   * src/transport.ts's LoginRequest doc comment for why that field is
   * retired, not merely unused). The triple-MD5 chain itself
   * (src/wyze-auth-hash.ts) is UNCHANGED — the measurement confirmed it,
   * not just the pre-existing belief. */
  async login(req: LoginRequest): Promise<WyzeAuthEnvelope> {
    return this.postAuth(
      `https://${WYZE_AUTH_HOST}${WYZE_LOGIN_PATH}`,
      { email: req.email, password: req.passwordHash },
      { keyid: req.keyId, apikey: req.keySecret },
    );
  }

  /**
   * The MFA-answer endpoint/body shape remains UNOBSERVED BY ANYONE (no
   * account this epic has touched has ever been challenged — see
   * src/wyze-auth-envelope.ts's header comment) — this stays tier (d), a
   * design call this author makes and states rather than infers silently.
   * DESIGN CALL: mirror login()'s now-measured shape (keyid/apikey as
   * headers, minimal body) rather than the pre-WYZR-15 pattern (all
   * fields in one body). Reasoning: submitMfa() re-POSTs to the SAME
   * login endpoint as login() itself, per the common reverse-engineered
   * mobile-app pattern this project has always assumed for it; since that
   * endpoint's PLAIN-login shape is now measured to reject keyid/apikey
   * in the body, the most defensible assumption is that a CHALLENGE
   * answer to the same endpoint follows the same header placement, with
   * only the challenge-specific fields (`mfa_type`/`verification_id`/
   * `verification_code`) added to the body alongside `email`/`password`.
   * The alternative (assume the pre-WYZR-15 shape was right for THIS
   * call specifically) has strictly LESS evidence behind it now that the
   * plain-login half of that same shape is confirmed wrong. Expect
   * correction the moment a real account is challenged.
   */
  async submitMfa(req: SubmitMfaRequest): Promise<WyzeAuthEnvelope> {
    return this.postAuth(
      `https://${WYZE_AUTH_HOST}${WYZE_LOGIN_PATH}`,
      {
        email: req.email,
        password: req.passwordHash,
        mfa_type: req.mfaType,
        verification_id: req.verificationId,
        verification_code: req.verificationCode,
      },
      { keyid: req.keyId, apikey: req.keySecret },
    );
  }

  /** Goes to the DEVICE host (WYZE_API_HOST), not the auth host — see
   * src/transport.ts's WyzeTransport doc comment. Its response keeps the
   * device host's own {code,msg,data} shape, unchanged by WYZR-15. Gets
   * the device-host standard body like every other api.wyzecam.com call
   * (postDevice() below) — this specific call's own shape was not
   * re-measured this round, but it shares the host, and every OTHER call
   * to that host rejects a body lacking these fields, so sending them here
   * too is the defensible default, not an untested guess in the opposite,
   * riskier direction (omitting them, when every sibling call needs them). */
  async refreshToken(req: RefreshTokenRequest): Promise<WyzeEnvelope> {
    return this.postDevice(`https://${WYZE_API_HOST}${WYZE_REFRESH_TOKEN_PATH}`, {
      refresh_token: req.refreshToken,
      keyid: req.keyId,
      apikey: req.keySecret,
    });
  }

  /** `access_token` carried in the JSON body, not an Authorization header
   * — confirmed by WYZR-15's measurement (previously tier (d)). Gets the
   * device-host standard body via postDevice() below — a bare
   * `{access_token}` body, this project's pre-WYZR-15 shape, is REJECTED
   * by the real host (`{"code":"1001","msg":"INVALID_PARAMETER"}`, this
   * ticket's own confirmed reproduction of the failure mode). */
  async getObjectList(req: GetObjectListRequest): Promise<WyzeEnvelope> {
    return this.postDevice(`https://${WYZE_API_HOST}${WYZE_GET_OBJECT_LIST_PATH}`, {
      access_token: req.accessToken,
    });
  }

  /** Body field names corrected by WYZR-15's measurement: `device_mac`/
   * `device_model`, not this project's earlier guess of bare `mac`/
   * `model` (which the real host rejects: `{"code":"1001","msg":"device_mac
   * cannot be empty"}`). `target_pid_list` was already right. */
  async getPropertyList(req: GetPropertyListRequest): Promise<WyzeEnvelope> {
    return this.postDevice(`https://${WYZE_API_HOST}${WYZE_GET_PROPERTY_LIST_PATH}`, {
      access_token: req.accessToken,
      device_mac: req.mac,
      device_model: req.model,
      target_pid_list: req.targetPids,
    });
  }

  /** Body field names AND wire type corrected by WYZR-15's measurement:
   * `device_mac`/`device_model` (as getPropertyList() above), and the
   * value field is `pvalue`, NOT `value` — carrying `req.value`, typed
   * `"0" | "1"` on the request (src/transport.ts), so JSON.stringify
   * emits a bare STRING, never a boolean and never a bare number. This is
   * decision (A), REVISED (src/transport.ts's SetPropertyRequest doc
   * comment), enforced at the wire, not just at the decode-response layer
   * (src/plug.ts's decodeP3()). */
  async setProperty(req: SetPropertyRequest): Promise<WyzeEnvelope> {
    return this.postDevice(`https://${WYZE_API_HOST}${WYZE_SET_PROPERTY_PATH}`, {
      access_token: req.accessToken,
      device_mac: req.mac,
      device_model: req.model,
      pid: req.pid,
      pvalue: req.value,
    });
  }

  /** POSTs `body` with `headers` and returns the HTTP status alongside the
   * parsed JSON — the one place a JSON-parse failure is turned into a
   * Network CliError, shared by `postDevice` (device host) and `postAuth`
   * (auth host) below. */
  private async request(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; parsed: unknown }> {
    const response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });

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

    return { status: response.status, parsed };
  }

  /** Device-host calls (refreshToken/getObjectList/getPropertyList/
   * setProperty). Merges src/wyze-device-identity.ts's
   * `deviceStandardBody()` into EVERY call's body automatically — a
   * caller here can never forget it, which is the whole point after
   * WYZR-15 found every one of these calls silently rejected without it.
   * `body` (call-specific fields) is spread AFTER the standard body so a
   * call's own fields always win on any (currently nonexistent) key
   * collision. Discards the HTTP status on the JSON-parses-fine path,
   * unchanged from before WYZR-15 — the device host's {code,msg,data}
   * envelope carries its own error signal in the body regardless of
   * status (structural fact: the device host answers HTTP 200 even on
   * error), so this stays byte-for-byte identical to its pre-WYZR-15
   * behavior in its own code path, per the ticket's explicit requirement. */
  private async postDevice(url: string, body: Record<string, unknown>): Promise<WyzeEnvelope> {
    const { parsed } = await this.request(url, { ...deviceStandardBody(), ...body }, { "content-type": "application/json" });
    return toEnvelope(parsed);
  }

  /** Auth-host calls (login/submitMfa) — see src/wyze-auth-envelope.ts.
   * `extraHeaders` carries `keyid`/`apikey` (see login()/submitMfa()
   * above) — no `deviceStandardBody()` here; that shape belongs to the
   * OTHER host and was never observed on this one. Unlike `postDevice`,
   * keeps the HTTP status (see structural fact 3 in the ticket: before
   * WYZR-15, an HTTP 400 whose body parsed as JSON was silently treated
   * identically to HTTP 200) — though every WyzeAuthEnvelope function
   * still classifies by BODY SHAPE, not this status; see that module's
   * header comment for why. */
  private async postAuth(
    url: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
  ): Promise<WyzeAuthEnvelope> {
    const { status, parsed } = await this.request(url, body, { "content-type": "application/json", ...extraHeaders });
    return toAuthEnvelope(parsed, status);
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

/**
 * Normalizes an arbitrary parsed JSON value into a WyzeAuthEnvelope — the
 * auth-host counterpart of toEnvelope() above. No `data` unwrapping: per
 * src/wyze-auth-envelope.ts's header comment, the auth host's own fields
 * (`access_token`, `errorCode`, `mfa_options`, ...) live at the TOP LEVEL
 * of the body, so the whole parsed object becomes `raw` as-is.
 * registerAnyTokenFields() is reused unchanged — it already reads
 * `access_token`/`refresh_token` off whatever object it is given,
 * regardless of nesting — and is called before this function returns to
 * ANY caller, for the same reason toEnvelope() calls it unconditionally:
 * an error-shaped response could still carry a token-shaped field.
 */
function toAuthEnvelope(parsed: unknown, httpStatus: number): WyzeAuthEnvelope {
  const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  registerAnyTokenFields(raw);
  return { httpStatus, raw };
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
