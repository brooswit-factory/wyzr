// The Wyze auth session: logs in once, holds tokens in memory, answers a
// TOTP MFA challenge automatically when a secret is configured, and
// refreshes-and-retries exactly once on an expired access token. Never
// re-logs-in per call (docs/wyze-api-findings-2026-09-02.md §Q5: the
// SDK's own maintainer calls that pattern "deprecated due to issues with
// authentication rate limiting"). Written entirely against the
// WyzeTransport interface (src/transport.ts) — never against
// RealWyzeTransport or FakeWyzeTransport directly — so it is fully
// unit-testable with the fake and zero network, per the ticket.
//
// *** MFA-CHALLENGE DETECTION IS, BY CONSTRUCTION, UNTESTED AGAINST
// REALITY. *** Whether the account that eventually gets provisioned will
// hit MFA at all, and which kind, is unknowable until that account exists
// (finding §3, explicit unknown #2) — this module's TOTP math is proven
// correct against RFC 6238's own vectors (src/totp.ts), but the plumbing
// that DETECTS a challenge and the shape it expects from Wyze's wire
// format are this author's inference (tier (d), corroborated tier (b) by
// a community-SDK source read — see src/wyze-auth-envelope.ts's header
// comment and its detectAuthMfaChallenge()) and have never run against a
// real challenge.

import type { Credentials } from "./credentials.ts";
import { registerSecret } from "./redact.ts";
import type { WyzeTransport } from "./transport.ts";
import { totpFromBase32Secret } from "./totp.ts";
import {
  detectAuthMfaChallenge,
  extractAuthTokens,
  isAuthInvalidCredentialsCode,
  isAuthSuccessEnvelope,
  type MfaChallenge,
  type WyzeAuthEnvelope,
} from "./wyze-auth-envelope.ts";
import { extractTokens, isAccessTokenExpired, isSuccessEnvelope, type WyzeEnvelope } from "./wyze-envelope.ts";
import { wyzeTripleMd5 } from "./wyze-auth-hash.ts";
import {
  wyzeAccessTokenRefreshLoopError,
  wyzeGenericApiError,
  wyzeGenericAuthApiError,
  wyzeInvalidCredentialsOrSsoOnlyError,
  wyzeMalformedSuccessError,
  wyzeMfaSmsUnsupportedError,
  wyzeMfaTotpSecretInvalidError,
  wyzeMfaTotpSecretMissingError,
  wyzeMfaUnknownTypeError,
  wyzeNotAuthenticatedError,
  wyzeRefreshFailedError,
  wyzeRefreshWithoutLoginError,
} from "./wyze-errors.ts";

/** `now` is injectable so tests can supply a deterministic clock for TOTP
 * generation. No `nonce` dependency — WYZR-15's live-account measurement
 * showed the login body carries no nonce at all (see
 * src/transport.ts's LoginRequest doc comment); this project's earlier,
 * never-confirmed belief that one was required is retired with it. */
export interface AuthSessionDeps {
  transport: WyzeTransport;
  credentials: Credentials;
  now?: () => number;
}

export class WyzeAuthSession {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;

  constructor(private readonly deps: AuthSessionDeps) {}

  /** True once a successful login (or MFA-completed login) has stored tokens. */
  isAuthenticated(): boolean {
    return this.accessToken !== undefined;
  }

  async login(): Promise<void> {
    const envelope = await this.deps.transport.login({
      email: this.deps.credentials.email,
      passwordHash: this.hashedPassword(),
      keyId: this.deps.credentials.keyId,
      keySecret: this.deps.credentials.keySecret,
    });
    await this.handleAuthEnvelope(envelope);
  }

  /** The triple-MD5 password hash, registered for redaction the moment it
   * is computed. It is a password-EQUIVALENT (it is exactly what goes on
   * the wire to authenticate), not merely password-derived, so it gets the
   * same treatment as the tokens even though nothing currently prints it —
   * this guards the path someone adds later, not a live leak today. */
  private hashedPassword(): string {
    const hash = wyzeTripleMd5(this.deps.credentials.password);
    registerSecret(hash);
    return hash;
  }

  /**
   * Interprets a login/submitMfa response — BOTH go to the auth host, so
   * this reads the AUTH envelope (src/wyze-auth-envelope.ts), never the
   * device host's WyzeEnvelope (see that module's header comment for why
   * they are no longer the same type). MFA-challenge detection is checked
   * BEFORE error/success interpretation — deliberately: neither the
   * finding nor the source reading behind wyze-auth-envelope.ts pins down
   * what accompanies a challenge, so gating on `mfa_options`'s shape
   * instead keeps this correct regardless of that unresolved unknown.
   */
  private async handleAuthEnvelope(envelope: WyzeAuthEnvelope): Promise<void> {
    const challenge = detectAuthMfaChallenge(envelope);
    if (challenge) {
      await this.answerMfaChallenge(challenge);
      return;
    }
    if (isAuthSuccessEnvelope(envelope)) {
      this.storeAuthTokens(envelope);
      return;
    }
    if (isAuthInvalidCredentialsCode(envelope)) {
      throw wyzeInvalidCredentialsOrSsoOnlyError();
    }
    throw wyzeGenericAuthApiError(envelope);
  }

  private async answerMfaChallenge(challenge: MfaChallenge): Promise<void> {
    if (challenge.mfaType === "SMS") {
      throw wyzeMfaSmsUnsupportedError();
    }
    if (challenge.mfaType === "UNKNOWN") {
      throw wyzeMfaUnknownTypeError();
    }

    const secret = this.deps.credentials.totpSecret;
    if (!secret) {
      throw wyzeMfaTotpSecretMissingError();
    }

    let code: string;
    try {
      code = totpFromBase32Secret(secret, (this.deps.now?.() ?? Date.now()) / 1000);
    } catch (cause) {
      throw wyzeMfaTotpSecretInvalidError(cause);
    }

    const envelope = await this.deps.transport.submitMfa({
      email: this.deps.credentials.email,
      passwordHash: this.hashedPassword(),
      keyId: this.deps.credentials.keyId,
      keySecret: this.deps.credentials.keySecret,
      verificationId: challenge.verificationId,
      mfaType: "TOTP",
      verificationCode: code,
    });

    // Deliberately NOT re-entering handleAuthEnvelope (which would check
    // for another MFA challenge): one challenge-and-answer round only,
    // never a loop.
    if (isAuthSuccessEnvelope(envelope)) {
      this.storeAuthTokens(envelope);
      return;
    }
    if (isAuthInvalidCredentialsCode(envelope)) {
      throw wyzeInvalidCredentialsOrSsoOnlyError();
    }
    throw wyzeGenericAuthApiError(envelope);
  }

  /** Auth-host counterpart of storeTokens() below — used by login()/the
   * MFA-answer path only (see handleAuthEnvelope()). */
  private storeAuthTokens(envelope: WyzeAuthEnvelope): void {
    let tokens: { accessToken: string; refreshToken: string };
    try {
      tokens = extractAuthTokens(envelope);
    } catch (cause) {
      throw wyzeMalformedSuccessError(cause);
    }
    this.setTokens(tokens);
  }

  /** Device-host counterpart of storeAuthTokens() above — used by
   * refresh() only, since refreshToken() hits the device host (see
   * src/transport.ts's WyzeTransport doc comment) and its response keeps
   * the device host's own {code,msg,data} shape. */
  private storeTokens(envelope: WyzeEnvelope): void {
    let tokens: { accessToken: string; refreshToken: string };
    try {
      tokens = extractTokens(envelope);
    } catch (cause) {
      throw wyzeMalformedSuccessError(cause);
    }
    this.setTokens(tokens);
  }

  private setTokens(tokens: { accessToken: string; refreshToken: string }): void {
    // Registered the moment they are received into this session — before
    // returning control to any caller that might print something.
    registerSecret(tokens.accessToken);
    registerSecret(tokens.refreshToken);
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw wyzeRefreshWithoutLoginError();
    }
    const envelope = await this.deps.transport.refreshToken({
      refreshToken: this.refreshToken,
      keyId: this.deps.credentials.keyId,
      keySecret: this.deps.credentials.keySecret,
    });
    if (isSuccessEnvelope(envelope)) {
      this.storeTokens(envelope);
      return;
    }
    // A refresh that itself fails surfaces an error, per the ticket — it
    // never falls back to re-running the password login automatically.
    throw wyzeRefreshFailedError(envelope);
  }

  /** The one call `wyzr devices list` needs from this interface.
   * Authenticates via the held access token, refreshing and retrying
   * exactly once on an expired token. */
  async getObjectList(): Promise<unknown> {
    return this.callAuthenticated((accessToken) => this.deps.transport.getObjectList({ accessToken }));
  }

  /** WYZR-13's addition, for `wyzr plug status` and the read-back half of
   * `wyzr plug on`/`off` (decision (D)). Same refresh-and-retry-once
   * discipline as every other authenticated call here — no separate
   * polling/retry loop of its own; decision (D) forbids one entirely. */
  async getPropertyList(mac: string, model: string, targetPids: string[]): Promise<unknown> {
    return this.callAuthenticated((accessToken) =>
      this.deps.transport.getPropertyList({ accessToken, mac, model, targetPids }),
    );
  }

  /** WYZR-13's addition, REVISED by WYZR-15: `value` is `"0" | "1"`, a
   * STRING literal union, never `boolean` and never a bare number —
   * decision (A), revised (see src/transport.ts's SetPropertyRequest doc
   * comment), enforced at this call's own signature, not just downstream. */
  async setProperty(mac: string, model: string, pid: string, value: "0" | "1"): Promise<unknown> {
    return this.callAuthenticated((accessToken) =>
      this.deps.transport.setProperty({ accessToken, mac, model, pid, value }),
    );
  }

  private async callAuthenticated(
    call: (accessToken: string) => Promise<WyzeEnvelope>,
    alreadyRetried = false,
  ): Promise<unknown> {
    if (!this.accessToken) {
      throw wyzeNotAuthenticatedError();
    }
    const envelope = await call(this.accessToken);

    if (isSuccessEnvelope(envelope)) {
      return envelope.data;
    }
    if (isAccessTokenExpired(envelope)) {
      if (alreadyRetried) {
        // Bounded: refresh-and-retry happens exactly once. A second
        // expiry right after a fresh refresh is treated as a hard
        // failure, not another refresh attempt — see the ticket's
        // "guard against infinite recursion" requirement.
        throw wyzeAccessTokenRefreshLoopError();
      }
      await this.refresh();
      return this.callAuthenticated(call, true);
    }
    throw wyzeGenericApiError(envelope);
  }
}
