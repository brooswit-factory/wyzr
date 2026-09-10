// The AUTH host's own envelope (auth-prod.api.wyze.com) — deliberately a
// SEPARATE module/type from wyze-envelope.ts's DEVICE-host {code,msg,data}
// envelope. See src/wyze-auth-envelope.ts's header comment for the
// measurement/source-reading this is built from (WYZR-15).
//
// RED-FIRST: this file was written, then run once against a deliberately
// wrong `authErrorCode 1000` comparison (`=== "1001"` instead of `"1000"`)
// in isAuthInvalidCredentialsCode() — see the PR body for the exact red
// output observed. Restored and green since.

import { describe, expect, test } from "bun:test";
import {
  authErrorCode,
  authErrorDescription,
  authRequestId,
  detectAuthMfaChallenge,
  extractAuthTokens,
  isAuthErrorEnvelope,
  isAuthInvalidCredentialsCode,
  isAuthSuccessEnvelope,
  type WyzeAuthEnvelope,
} from "../../src/wyze-auth-envelope.ts";

// This is this ticket's own CAPTURED-LIVE measurement (WYZR-15, 2026-09-10):
// a POST to the real auth host with placeholder credentials returned this
// exact shape. See the PR body for the raw transcript and
// src/transport-fake.ts's fakeAuthInvalidCredentialsEnvelope() for the
// fixture built from it.
const CAPTURED_LIVE_ERROR: WyzeAuthEnvelope = {
  httpStatus: 400,
  raw: {
    description: "Invalid credentials, please check username, password, keyid or apikey",
    requestId: "4881e8e9-7d7a-420c-a9af-da20ea49a38d",
    errorCode: 1000,
  },
};

describe("isAuthErrorEnvelope / authErrorCode / authErrorDescription / authRequestId", () => {
  test("recognizes the captured-live error shape", () => {
    expect(isAuthErrorEnvelope(CAPTURED_LIVE_ERROR)).toBe(true);
    expect(authErrorCode(CAPTURED_LIVE_ERROR)).toBe("1000");
    expect(authErrorDescription(CAPTURED_LIVE_ERROR)).toBe(
      "Invalid credentials, please check username, password, keyid or apikey",
    );
    expect(authRequestId(CAPTURED_LIVE_ERROR)).toBe("4881e8e9-7d7a-420c-a9af-da20ea49a38d");
  });

  // This ticket's own criterion-9 sweep observed errorCode 5000
  // ("Internal Error") for a missing required field — same SHAPE,
  // different code. Confirms detection keys on the shape, not on 1000
  // specifically.
  test("recognizes a different errorCode under the same shape", () => {
    const envelope: WyzeAuthEnvelope = {
      httpStatus: 400,
      raw: { description: "Internal Error", requestId: "eadee228-9d64-4f43-b785-2e0730619e1c", errorCode: 5000 },
    };
    expect(isAuthErrorEnvelope(envelope)).toBe(true);
    expect(authErrorCode(envelope)).toBe("5000");
  });

  test("handles errorCode arriving as a JSON number, not a string (MEASURED wire type)", () => {
    expect(typeof CAPTURED_LIVE_ERROR.raw["errorCode"]).toBe("number");
    expect(authErrorCode(CAPTURED_LIVE_ERROR)).toBe("1000");
  });

  test("also handles errorCode arriving as a string (defensive, like the device host's normalizeCode)", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 400, raw: { errorCode: "1000", description: "d", requestId: "r" } };
    expect(authErrorCode(envelope)).toBe("1000");
  });

  test("is not an error envelope when errorCode is absent (success/MFA shapes)", () => {
    expect(isAuthErrorEnvelope({ httpStatus: 200, raw: { access_token: "at", refresh_token: "rt" } })).toBe(false);
  });

  test("authErrorDescription/authRequestId are empty/undefined, not \"undefined\", when absent", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 400, raw: { errorCode: 9999 } };
    expect(authErrorDescription(envelope)).toBe("");
    expect(authRequestId(envelope)).toBeUndefined();
  });
});

describe("isAuthInvalidCredentialsCode", () => {
  test("matches the captured-live errorCode 1000 (the specific trap this ticket exists to fix)", () => {
    expect(isAuthInvalidCredentialsCode(CAPTURED_LIVE_ERROR)).toBe(true);
  });

  test("does not match a different errorCode", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 400, raw: { errorCode: 5000, description: "d", requestId: "r" } };
    expect(isAuthInvalidCredentialsCode(envelope)).toBe(false);
  });

  test("does not match a success envelope", () => {
    expect(isAuthInvalidCredentialsCode({ httpStatus: 200, raw: { access_token: "at", refresh_token: "rt" } })).toBe(
      false,
    );
  });
});

describe("isAuthSuccessEnvelope — reads access_token at the TOP LEVEL, not nested under `data`", () => {
  test("true when a top-level access_token string is present", () => {
    expect(isAuthSuccessEnvelope({ httpStatus: 200, raw: { access_token: "at", refresh_token: "rt" } })).toBe(true);
  });

  test("false for the captured-live error shape (no access_token at all)", () => {
    expect(isAuthSuccessEnvelope(CAPTURED_LIVE_ERROR)).toBe(false);
  });

  // The exact bug this ticket fixes: a device-shaped {code:"1",...}
  // envelope must NOT be mistaken for an auth success, because the auth
  // host never sends `code` at all.
  test("false for a device-shaped code:\"1\" envelope with no access_token", () => {
    expect(isAuthSuccessEnvelope({ httpStatus: 200, raw: { code: "1", msg: "", data: {} } })).toBe(false);
  });

  test("false when access_token is an empty string", () => {
    expect(isAuthSuccessEnvelope({ httpStatus: 200, raw: { access_token: "", refresh_token: "rt" } })).toBe(false);
  });
});

describe("detectAuthMfaChallenge — reads the auth host's own (source-read-corroborated) field layout", () => {
  test("detects TOTP via mfa_options + mfa_details.totp_apps[0].app_id", () => {
    const envelope: WyzeAuthEnvelope = {
      httpStatus: 200,
      raw: {
        mfa_options: ["TotpVerificationCode"],
        mfa_details: { totp_apps: [{ app_id: "totp-app-id-123" }] },
      },
    };
    expect(detectAuthMfaChallenge(envelope)).toEqual({ mfaType: "TOTP", verificationId: "totp-app-id-123" });
  });

  test("detects SMS via mfa_options + sms_session_id", () => {
    const envelope: WyzeAuthEnvelope = {
      httpStatus: 200,
      raw: { mfa_options: ["PrimaryPhone"], sms_session_id: "sms-session-456" },
    };
    expect(detectAuthMfaChallenge(envelope)).toEqual({ mfaType: "SMS", verificationId: "sms-session-456" });
  });

  test("classifies an unrecognized option as UNKNOWN rather than guessing", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 200, raw: { mfa_options: ["SomethingElse"] } };
    expect(detectAuthMfaChallenge(envelope)?.mfaType).toBe("UNKNOWN");
  });

  test("returns undefined for a plain success envelope", () => {
    expect(detectAuthMfaChallenge({ httpStatus: 200, raw: { access_token: "at", refresh_token: "rt" } })).toBeUndefined();
  });

  test("returns undefined for the captured-live error envelope", () => {
    expect(detectAuthMfaChallenge(CAPTURED_LIVE_ERROR)).toBeUndefined();
  });

  test("returns undefined when mfa_options is present but empty", () => {
    expect(detectAuthMfaChallenge({ httpStatus: 200, raw: { mfa_options: [] } })).toBeUndefined();
  });

  test("TOTP is not detected without a resolvable mfa_details.totp_apps[0].app_id", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 200, raw: { mfa_options: ["TotpVerificationCode"] } };
    expect(detectAuthMfaChallenge(envelope)).toBeUndefined();
  });

  test("TOTP is not detected when mfa_details.totp_apps is present but empty", () => {
    const envelope: WyzeAuthEnvelope = {
      httpStatus: 200,
      raw: { mfa_options: ["TotpVerificationCode"], mfa_details: { totp_apps: [] } },
    };
    expect(detectAuthMfaChallenge(envelope)).toBeUndefined();
  });
});

describe("extractAuthTokens — reads access_token/refresh_token at the TOP LEVEL", () => {
  test("extracts both tokens", () => {
    const envelope: WyzeAuthEnvelope = { httpStatus: 200, raw: { access_token: "at-123", refresh_token: "rt-456" } };
    expect(extractAuthTokens(envelope)).toEqual({ accessToken: "at-123", refreshToken: "rt-456" });
  });

  test("throws when access_token is missing", () => {
    expect(() => extractAuthTokens({ httpStatus: 200, raw: { refresh_token: "rt" } })).toThrow(/access_token/);
  });

  test("throws when refresh_token is missing", () => {
    expect(() => extractAuthTokens({ httpStatus: 200, raw: { access_token: "at" } })).toThrow(/refresh_token/);
  });
});
