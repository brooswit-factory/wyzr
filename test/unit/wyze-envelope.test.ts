import { describe, expect, test } from "bun:test";
import {
  detectMfaChallenge,
  extractTokens,
  isAccessTokenExpired,
  isInvalidCredentialsCode,
  isSuccessEnvelope,
  normalizeCode,
  normalizeMsg,
  type WyzeEnvelope,
} from "../../src/wyze-envelope.ts";

describe("normalizeCode / normalizeMsg", () => {
  test("normalizeCode stringifies a number", () => {
    expect(normalizeCode(1000)).toBe("1000");
  });

  test("normalizeCode passes through a string", () => {
    expect(normalizeCode("1000")).toBe("1000");
  });

  test("normalizeMsg returns empty string for undefined/null", () => {
    expect(normalizeMsg(undefined)).toBe("");
    expect(normalizeMsg(null)).toBe("");
  });

  test("normalizeMsg passes through a string", () => {
    expect(normalizeMsg("AccessTokenError")).toBe("AccessTokenError");
  });
});

// This is the specific test the ticket requires be run red-first: the
// finding is explicit that `code == "1"` is a STRING, and a strict
// equality check against the NUMBER 1 would be silently wrong. See the
// PR body for the red output observed when isSuccessEnvelope was
// temporarily changed to `envelope.code === 1` (number) instead of
// `normalizeCode(envelope.code) === "1"`.
describe("isSuccessEnvelope — string-vs-number code (the finding's specific warning)", () => {
  test("treats the STRING \"1\" as success", () => {
    expect(isSuccessEnvelope({ code: "1", msg: "", data: {} })).toBe(true);
  });

  test("also treats the NUMBER 1 as success (defensive about wire-type ambiguity both ways)", () => {
    expect(isSuccessEnvelope({ code: 1, msg: "", data: {} })).toBe(true);
  });

  test("does not treat \"10\" as success (no accidental substring/prefix match)", () => {
    expect(isSuccessEnvelope({ code: "10", msg: "", data: {} })).toBe(false);
  });

  test("does not treat 0 as success", () => {
    expect(isSuccessEnvelope({ code: 0, msg: "", data: {} })).toBe(false);
  });
});

describe("isInvalidCredentialsCode", () => {
  test("matches the number 1000", () => {
    expect(isInvalidCredentialsCode({ code: 1000, msg: "", data: {} })).toBe(true);
  });

  test("matches the string \"1000\"", () => {
    expect(isInvalidCredentialsCode({ code: "1000", msg: "", data: {} })).toBe(true);
  });

  test("does not match success", () => {
    expect(isInvalidCredentialsCode({ code: "1", msg: "", data: {} })).toBe(false);
  });
});

describe("isAccessTokenExpired", () => {
  test("matches the number 2001", () => {
    expect(isAccessTokenExpired({ code: 2001, msg: "", data: {} })).toBe(true);
  });

  test("matches the string \"2001\"", () => {
    expect(isAccessTokenExpired({ code: "2001", msg: "", data: {} })).toBe(true);
  });

  test("matches msg === \"AccessTokenError\" even with an unrelated code", () => {
    expect(isAccessTokenExpired({ code: "1", msg: "AccessTokenError", data: {} })).toBe(true);
  });

  test("does not match an unrelated code/msg", () => {
    expect(isAccessTokenExpired({ code: "1", msg: "ok", data: {} })).toBe(false);
  });
});

describe("detectMfaChallenge", () => {
  test("detects a TOTP challenge from mfa_options", () => {
    const envelope: WyzeEnvelope = {
      code: "90955",
      msg: "MfaRequired",
      data: { mfa_options: ["TotpVerificationCode"], verification_id: "vid-123" },
    };
    expect(detectMfaChallenge(envelope)).toEqual({ mfaType: "TOTP", verificationId: "vid-123" });
  });

  test("detects an SMS challenge from mfa_options", () => {
    const envelope: WyzeEnvelope = {
      code: "90955",
      msg: "MfaRequired",
      data: { mfa_options: ["PrimaryPhone"], verification_id: "vid-456" },
    };
    expect(detectMfaChallenge(envelope)).toEqual({ mfaType: "SMS", verificationId: "vid-456" });
  });

  test("falls back to sms_session_id when verification_id is absent", () => {
    const envelope: WyzeEnvelope = {
      code: "90955",
      msg: "MfaRequired",
      data: { mfa_options: ["PrimaryPhone"], sms_session_id: "sms-789" },
    };
    expect(detectMfaChallenge(envelope)).toEqual({ mfaType: "SMS", verificationId: "sms-789" });
  });

  test("classifies an unrecognized option as UNKNOWN rather than guessing", () => {
    const envelope: WyzeEnvelope = {
      code: "90955",
      msg: "MfaRequired",
      data: { mfa_options: ["SomethingElse"], verification_id: "vid-999" },
    };
    expect(detectMfaChallenge(envelope)?.mfaType).toBe("UNKNOWN");
  });

  test("detects a challenge regardless of `code` — the finding does not pin down what code accompanies one", () => {
    const envelope: WyzeEnvelope = {
      code: "1",
      msg: "",
      data: { mfa_options: ["TotpVerificationCode"], verification_id: "vid-1" },
    };
    expect(detectMfaChallenge(envelope)).toEqual({ mfaType: "TOTP", verificationId: "vid-1" });
  });

  test("returns undefined for a plain success envelope", () => {
    const envelope: WyzeEnvelope = {
      code: "1",
      msg: "",
      data: { access_token: "at", refresh_token: "rt" },
    };
    expect(detectMfaChallenge(envelope)).toBeUndefined();
  });

  test("returns undefined when mfa_options is present but empty", () => {
    const envelope: WyzeEnvelope = { code: "1", msg: "", data: { mfa_options: [] } };
    expect(detectMfaChallenge(envelope)).toBeUndefined();
  });

  test("returns undefined when mfa_options is present but no verification id exists", () => {
    const envelope: WyzeEnvelope = { code: "1", msg: "", data: { mfa_options: ["TotpVerificationCode"] } };
    expect(detectMfaChallenge(envelope)).toBeUndefined();
  });

  test("returns undefined when data is not an object", () => {
    expect(detectMfaChallenge({ code: "1", msg: "", data: null })).toBeUndefined();
    expect(detectMfaChallenge({ code: "1", msg: "", data: "oops" })).toBeUndefined();
  });
});

describe("extractTokens", () => {
  test("extracts access_token and refresh_token from data", () => {
    const envelope: WyzeEnvelope = {
      code: "1",
      msg: "",
      data: { access_token: "at-123", refresh_token: "rt-456" },
    };
    expect(extractTokens(envelope)).toEqual({ accessToken: "at-123", refreshToken: "rt-456" });
  });

  test("throws when data is missing", () => {
    expect(() => extractTokens({ code: "1", msg: "", data: undefined })).toThrow();
  });

  test("throws when access_token is missing", () => {
    expect(() => extractTokens({ code: "1", msg: "", data: { refresh_token: "rt" } })).toThrow(/access_token/);
  });

  test("throws when refresh_token is missing", () => {
    expect(() => extractTokens({ code: "1", msg: "", data: { access_token: "at" } })).toThrow(/refresh_token/);
  });
});
