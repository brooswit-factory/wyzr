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
// format are this author's inference (tier (d); see
// src/wyze-envelope.ts's detectMfaChallenge() comment) and have never run
// against a real challenge.

import type { Credentials } from "./credentials.ts";
import { registerSecret } from "./redact.ts";
import type { WyzeTransport } from "./transport.ts";
import { totpFromBase32Secret } from "./totp.ts";
import {
  extractTokens,
  isAccessTokenExpired,
  isInvalidCredentialsCode,
  isSuccessEnvelope,
  detectMfaChallenge,
  type MfaChallenge,
  type WyzeEnvelope,
} from "./wyze-envelope.ts";
import { wyzeTripleMd5 } from "./wyze-auth-hash.ts";
import {
  wyzeAccessTokenRefreshLoopError,
  wyzeGenericApiError,
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

/** Injectable so tests can supply a deterministic nonce and clock instead
 * of the wall clock — the finding does not document a required nonce
 * FORMAT, only that one is sent (tier (b)); the default below (current
 * epoch millis as a string) is this author's own reasonable choice, not a
 * confirmed Wyze requirement. */
export interface AuthSessionDeps {
  transport: WyzeTransport;
  credentials: Credentials;
  nonce?: () => string;
  now?: () => number;
}

function defaultNonce(): string {
  return String(Date.now());
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
      passwordHash: wyzeTripleMd5(this.deps.credentials.password),
      nonce: this.currentNonce(),
      keyId: this.deps.credentials.keyId,
      keySecret: this.deps.credentials.keySecret,
    });
    await this.handleLoginEnvelope(envelope);
  }

  /**
   * Interprets a login response. MFA-challenge detection is checked
   * BEFORE `code`-based success/failure interpretation — deliberately: the
   * finding does not establish what `code` value accompanies a challenge,
   * so gating on `data`'s shape instead keeps this correct regardless of
   * that unresolved unknown (see wyze-envelope.ts's detectMfaChallenge()).
   */
  private async handleLoginEnvelope(envelope: WyzeEnvelope): Promise<void> {
    const challenge = detectMfaChallenge(envelope);
    if (challenge) {
      await this.answerMfaChallenge(challenge);
      return;
    }
    if (isSuccessEnvelope(envelope)) {
      this.storeTokens(envelope);
      return;
    }
    if (isInvalidCredentialsCode(envelope)) {
      throw wyzeInvalidCredentialsOrSsoOnlyError();
    }
    throw wyzeGenericApiError(envelope);
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
      passwordHash: wyzeTripleMd5(this.deps.credentials.password),
      nonce: this.currentNonce(),
      keyId: this.deps.credentials.keyId,
      keySecret: this.deps.credentials.keySecret,
      verificationId: challenge.verificationId,
      mfaType: "TOTP",
      verificationCode: code,
    });

    // Deliberately NOT re-entering handleLoginEnvelope (which would check
    // for another MFA challenge): one challenge-and-answer round only,
    // never a loop.
    if (isSuccessEnvelope(envelope)) {
      this.storeTokens(envelope);
      return;
    }
    if (isInvalidCredentialsCode(envelope)) {
      throw wyzeInvalidCredentialsOrSsoOnlyError();
    }
    throw wyzeGenericApiError(envelope);
  }

  private storeTokens(envelope: WyzeEnvelope): void {
    let tokens: { accessToken: string; refreshToken: string };
    try {
      tokens = extractTokens(envelope);
    } catch (cause) {
      throw wyzeMalformedSuccessError(cause);
    }
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

  /** The one call the next task (`wyzr devices list`) needs from this
   * interface. Authenticates via the held access token, refreshing and
   * retrying exactly once on an expired token. */
  async getObjectList(): Promise<unknown> {
    return this.callAuthenticated((accessToken) => this.deps.transport.getObjectList({ accessToken }));
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

  private currentNonce(): string {
    return (this.deps.nonce ?? defaultNonce)();
  }
}
