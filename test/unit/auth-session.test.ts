// Every test uses FakeWyzeTransport — zero network, zero real credentials.
// Fixture credential values are obviously fake, per the ticket's hard rule.

import { afterEach, describe, expect, test } from "bun:test";
import { WyzeAuthSession } from "../../src/auth-session.ts";
import type { Credentials } from "../../src/credentials.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { REDACTED, redact, resetSecretsForTesting } from "../../src/redact.ts";
import {
  FakeWyzeTransport,
  fakeAccessTokenExpiredEnvelope,
  fakeInvalidCredentialsEnvelope,
  fakeMfaSmsChallengeEnvelope,
  fakeMfaTotpChallengeEnvelope,
  fakeSuccessEnvelope,
} from "../../src/transport-fake.ts";
import type { WyzeEnvelope } from "../../src/wyze-envelope.ts";

afterEach(() => {
  resetSecretsForTesting();
});

const FAKE_CREDS: Credentials = {
  email: "test-account@example.invalid",
  password: "fake-test-password-000",
  keyId: "fake-key-id-000",
  keySecret: "fake-key-secret-000",
  totpSecret: undefined,
};

// Base32 of the RFC 6238 Appendix B ASCII test key "12345678901234567890"
// (round-trip-verified in test/unit/totp.test.ts). At timeSeconds=59 with
// this module's defaults (6 digits, 30s period), the correct TOTP is
// "287082" — the last 6 digits of the RFC's own published 8-digit vector
// "94287082" at the same counter (see totp.test.ts for the derivation).
const RFC_BASE32_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const EXPECTED_TOTP_AT_59S = "287082";

async function expectCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected the call to throw a CliError");
}

describe("WyzeAuthSession.login — success", () => {
  test("stores tokens and marks the session authenticated", async () => {
    const transport = new FakeWyzeTransport();
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    expect(session.isAuthenticated()).toBe(false);
    await session.login();
    expect(session.isAuthenticated()).toBe(true);
  });

  test("sends the triple-MD5 password hash, never the raw password, to the transport", async () => {
    let seenPasswordField = "";
    const transport = new FakeWyzeTransport({
      loginHandler: (req) => {
        seenPasswordField = req.passwordHash;
        return fakeSuccessEnvelope();
      },
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();

    expect(seenPasswordField).not.toBe(FAKE_CREDS.password);
    expect(seenPasswordField).toMatch(/^[0-9a-f]{32}$/);
  });

  test("uses the injected nonce function instead of the wall clock when provided", async () => {
    let seenNonce = "";
    const transport = new FakeWyzeTransport({
      loginHandler: (req) => {
        seenNonce = req.nonce;
        return fakeSuccessEnvelope();
      },
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS, nonce: () => "fixed-nonce-000" });
    await session.login();

    expect(seenNonce).toBe("fixed-nonce-000");
  });
});

describe("WyzeAuthSession.login — the errorCode 1000 trap", () => {
  test("names BOTH wrong-credentials and SSO-only-account possibilities, and points at the fix", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeInvalidCredentialsEnvelope() });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.login());
    expect(err.exitCode).toBe(ExitCode.CredentialsInvalid);
    expect(err.message).toMatch(/wrong|invalid/i);
    expect(err.message.toLowerCase()).toContain("sso");
    expect(err.message).toContain("Account");
    expect(err.message).toContain("Security");
    expect(err.message).toContain("Change Password");
  });
});

describe("WyzeAuthSession.login — MFA: TOTP", () => {
  test("answers a TOTP challenge automatically when totpSecret is configured, and succeeds", async () => {
    let seenCode = "";
    const transport = new FakeWyzeTransport({
      loginHandler: () => fakeMfaTotpChallengeEnvelope(),
      submitMfaHandler: (req) => {
        seenCode = req.verificationCode;
        expect(req.mfaType).toBe("TOTP");
        expect(req.verificationId).toBe("fake-verification-id-totp-000");
        return fakeSuccessEnvelope();
      },
    });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: RFC_BASE32_SECRET };
    const session = new WyzeAuthSession({ transport, credentials: creds, now: () => 59_000 });

    await session.login();

    expect(seenCode).toBe(EXPECTED_TOTP_AT_59S);
    expect(session.isAuthenticated()).toBe(true);
  });

  test("throws a clear MfaRequired error when a TOTP challenge arrives with no totpSecret configured", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaTotpChallengeEnvelope() });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.login());
    expect(err.exitCode).toBe(ExitCode.MfaRequired);
    expect(err.reason).toBe("mfa_totp_secret_missing");
    expect(err.message.toLowerCase()).toContain("totp");
  });

  // Covers WYZR-10's carried-forward fix: an empty-string totpSecret must
  // behave identically to no totpSecret at all, not as "configured".
  test("treats an empty-string totpSecret the same as absent", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaTotpChallengeEnvelope() });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: "" };
    const session = new WyzeAuthSession({ transport, credentials: creds });

    const err = await expectCliError(session.login());
    expect(err.reason).toBe("mfa_totp_secret_missing");
  });

  test("wraps an invalid (non-base32) totpSecret in a clear, actionable error instead of throwing raw", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaTotpChallengeEnvelope() });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: "not-valid-base32!!" };
    const session = new WyzeAuthSession({ transport, credentials: creds });

    const err = await expectCliError(session.login());
    expect(err.exitCode).toBe(ExitCode.MfaRequired);
    expect(err.reason).toBe("mfa_totp_secret_invalid");
  });

  test("a wrong TOTP answer surfaces the same errorCode-1000 trap error, not a generic failure", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => fakeMfaTotpChallengeEnvelope(),
      submitMfaHandler: () => fakeInvalidCredentialsEnvelope(),
    });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: RFC_BASE32_SECRET };
    const session = new WyzeAuthSession({ transport, credentials: creds, now: () => 59_000 });

    const err = await expectCliError(session.login());
    expect(err.reason).toBe("wyze_login_invalid_or_sso_only");
  });

  test("does not loop: a second MFA challenge after answering one is not retried", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => fakeMfaTotpChallengeEnvelope(),
      // Simulate a (synthetic, hypothetical) server that keeps re-challenging.
      submitMfaHandler: () => fakeMfaTotpChallengeEnvelope(),
    });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: RFC_BASE32_SECRET };
    const session = new WyzeAuthSession({ transport, credentials: creds, now: () => 59_000 });

    // Should throw (via wyzeGenericApiError, since the second challenge
    // envelope's `code` is not success/1000) rather than hang or recurse.
    await expectCliError(session.login());
  });
});

describe("WyzeAuthSession.login — MFA: SMS and unknown types", () => {
  test("throws a clear MfaRequired error for an SMS challenge — never silently ignored", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaSmsChallengeEnvelope() });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.login());
    expect(err.exitCode).toBe(ExitCode.MfaRequired);
    expect(err.reason).toBe("mfa_sms_unsupported");
  });

  test("throws a clear MfaRequired error for an unrecognized challenge type", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => ({
        code: "90955",
        msg: "MfaRequired",
        data: { mfa_options: ["SomeNewChallengeType"], verification_id: "vid-999" },
      }),
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.login());
    expect(err.reason).toBe("mfa_unknown_type");
  });
});

describe("WyzeAuthSession — getObjectList and token refresh", () => {
  async function loggedInSession(overrides: Partial<ConstructorParameters<typeof FakeWyzeTransport>[0]> = {}) {
    const transport = new FakeWyzeTransport(overrides);
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();
    return { transport, session };
  }

  test("returns the fake device list on the happy path", async () => {
    const { session } = await loggedInSession();
    const data = (await session.getObjectList()) as { device_list: unknown[] };
    expect(Array.isArray(data.device_list)).toBe(true);
  });

  test("refreshes and retries exactly once on an expired access token, then succeeds", async () => {
    let objectListCalls = 0;
    let refreshCalls = 0;
    const transport = new FakeWyzeTransport({
      getObjectListHandler: (): WyzeEnvelope => {
        objectListCalls += 1;
        return objectListCalls === 1
          ? fakeAccessTokenExpiredEnvelope()
          : { code: "1", msg: "", data: { device_list: ["after-refresh"] } };
      },
      refreshTokenHandler: (): WyzeEnvelope => {
        refreshCalls += 1;
        return fakeSuccessEnvelope({ accessToken: "refreshed-at-000" });
      },
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();

    const data = (await session.getObjectList()) as { device_list: string[] };

    expect(refreshCalls).toBe(1);
    expect(objectListCalls).toBe(2);
    expect(data.device_list).toEqual(["after-refresh"]);
  });

  test("bounded: refuses to retry a second time if the token expires again immediately after refresh", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeAccessTokenExpiredEnvelope(),
      refreshTokenHandler: () => fakeSuccessEnvelope({ accessToken: "refreshed-at-000" }),
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();

    const err = await expectCliError(session.getObjectList());
    expect(err.reason).toBe("wyze_access_token_refresh_loop");
  });

  test("surfaces an error, not a retry or a silent re-login, when the refresh call itself fails", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeAccessTokenExpiredEnvelope(),
      refreshTokenHandler: () => fakeInvalidCredentialsEnvelope(),
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();

    const err = await expectCliError(session.getObjectList());
    expect(err.reason).toBe("wyze_refresh_failed");
  });

  test("refuses an authenticated call before login()", async () => {
    const transport = new FakeWyzeTransport();
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.getObjectList());
    expect(err.reason).toBe("wyze_not_authenticated");
  });

  test("refuses refresh() before any login", async () => {
    const transport = new FakeWyzeTransport();
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.refresh());
    expect(err.reason).toBe("wyze_refresh_without_login");
  });
});

// The specific red-first test the ticket requires: run once with the
// registration removed to see it actually fail, restore, then trust it
// green. See the PR body for the exact red output observed when
// storeTokens()'s `registerSecret(tokens.accessToken)` /
// `registerSecret(tokens.refreshToken)` calls were temporarily commented
// out in src/auth-session.ts.
describe("WyzeAuthSession — token redaction (run red-first, see PR body)", () => {
  test("the access and refresh tokens from a successful login are redacted from all future output", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => fakeSuccessEnvelope({ accessToken: "leak-at-canary-000", refreshToken: "leak-rt-canary-000" }),
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    await session.login();

    expect(redact(`printed access token: leak-at-canary-000`)).toBe(`printed access token: ${REDACTED}`);
    expect(redact(`printed refresh token: leak-rt-canary-000`)).toBe(`printed refresh token: ${REDACTED}`);
  });

  test("tokens obtained via the MFA path are also redacted", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => fakeMfaTotpChallengeEnvelope(),
      submitMfaHandler: () => fakeSuccessEnvelope({ accessToken: "mfa-leak-at-000", refreshToken: "mfa-leak-rt-000" }),
    });
    const creds: Credentials = { ...FAKE_CREDS, totpSecret: RFC_BASE32_SECRET };
    const session = new WyzeAuthSession({ transport, credentials: creds, now: () => 59_000 });

    await session.login();

    expect(redact("mfa-leak-at-000")).toBe(REDACTED);
    expect(redact("mfa-leak-rt-000")).toBe(REDACTED);
  });

  test("tokens obtained via a refresh are also redacted", async () => {
    let objectListCalls = 0;
    const transport = new FakeWyzeTransport({
      getObjectListHandler: (): WyzeEnvelope => {
        objectListCalls += 1;
        return objectListCalls === 1
          ? fakeAccessTokenExpiredEnvelope()
          : { code: "1", msg: "", data: { device_list: [] } };
      },
      refreshTokenHandler: () => fakeSuccessEnvelope({ accessToken: "refresh-leak-at-000", refreshToken: "refresh-leak-rt-000" }),
    });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });
    await session.login();
    await session.getObjectList();

    expect(redact("refresh-leak-at-000")).toBe(REDACTED);
    expect(redact("refresh-leak-rt-000")).toBe(REDACTED);
  });
});

describe("WyzeAuthSession — malformed success response", () => {
  test("throws a clear error instead of storing undefined tokens", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => ({ code: "1", msg: "", data: {} }) });
    const session = new WyzeAuthSession({ transport, credentials: FAKE_CREDS });

    const err = await expectCliError(session.login());
    expect(err.reason).toBe("wyze_malformed_success_response");
  });
});
