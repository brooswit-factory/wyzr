import { describe, expect, test } from "bun:test";
import {
  FakeWyzeTransport,
  fakeAccessTokenExpiredEnvelope,
  fakeGetObjectListEnvelope,
  fakeInvalidCredentialsEnvelope,
  fakeMfaSmsChallengeEnvelope,
  fakeMfaTotpChallengeEnvelope,
  fakeSuccessEnvelope,
} from "../../src/transport-fake.ts";
import { detectMfaChallenge, isAccessTokenExpired, isInvalidCredentialsCode, isSuccessEnvelope } from "../../src/wyze-envelope.ts";

const REQ = { email: "e", passwordHash: "p", nonce: "n", keyId: "k", keySecret: "s" };

describe("FakeWyzeTransport — defaults", () => {
  test("login defaults to a success envelope", async () => {
    const transport = new FakeWyzeTransport();
    expect(isSuccessEnvelope(await transport.login(REQ))).toBe(true);
  });

  test("getObjectList defaults to the synthetic device-list envelope", async () => {
    const transport = new FakeWyzeTransport();
    const envelope = await transport.getObjectList({ accessToken: "at" });
    expect(isSuccessEnvelope(envelope)).toBe(true);
    expect((envelope.data as { device_list: unknown[] }).device_list.length).toBeGreaterThan(0);
  });
});

describe("FakeWyzeTransport — handler overrides drive every scenario a test needs", () => {
  test("can simulate an invalid-credentials (1000) login", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeInvalidCredentialsEnvelope() });
    const envelope = await transport.login(REQ);
    expect(isInvalidCredentialsCode(envelope)).toBe(true);
  });

  test("can simulate an expired-access-token response from getObjectList", async () => {
    const transport = new FakeWyzeTransport({ getObjectListHandler: () => fakeAccessTokenExpiredEnvelope() });
    const envelope = await transport.getObjectList({ accessToken: "at" });
    expect(isAccessTokenExpired(envelope)).toBe(true);
  });

  test("can simulate a TOTP MFA challenge on login", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaTotpChallengeEnvelope() });
    const challenge = detectMfaChallenge(await transport.login(REQ));
    expect(challenge?.mfaType).toBe("TOTP");
  });

  test("can simulate an SMS MFA challenge on login", async () => {
    const transport = new FakeWyzeTransport({ loginHandler: () => fakeMfaSmsChallengeEnvelope() });
    const challenge = detectMfaChallenge(await transport.login(REQ));
    expect(challenge?.mfaType).toBe("SMS");
  });

  test("can simulate a refresh-token failure", async () => {
    const transport = new FakeWyzeTransport({ refreshTokenHandler: () => fakeInvalidCredentialsEnvelope() });
    const envelope = await transport.refreshToken({ refreshToken: "rt", keyId: "k", keySecret: "s" });
    expect(isSuccessEnvelope(envelope)).toBe(false);
  });

  test("submitMfa can be overridden independently of login", async () => {
    const transport = new FakeWyzeTransport({ submitMfaHandler: () => fakeSuccessEnvelope({ accessToken: "mfa-at" }) });
    const envelope = await transport.submitMfa({ ...REQ, verificationId: "vid", mfaType: "TOTP", verificationCode: "000000" });
    expect((envelope.data as { access_token: string }).access_token).toBe("mfa-at");
  });
});

describe("fake envelope builders are all clearly synthetic fixtures", () => {
  test("fakeGetObjectListEnvelope's device is unambiguously labeled fake", () => {
    const envelope = fakeGetObjectListEnvelope();
    const device = (envelope.data as { device_list: Array<{ nickname: string }> }).device_list[0]!;
    expect(device.nickname.toLowerCase()).toContain("fake");
  });

  test("fakeSuccessEnvelope's default tokens are unambiguously labeled fake", () => {
    const envelope = fakeSuccessEnvelope();
    const data = envelope.data as { access_token: string; refresh_token: string };
    expect(data.access_token.toUpperCase()).toContain("FAKE");
    expect(data.refresh_token.toUpperCase()).toContain("FAKE");
  });
});
