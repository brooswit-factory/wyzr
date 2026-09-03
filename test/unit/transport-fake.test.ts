import { describe, expect, test } from "bun:test";
import {
  FAKE_PLUG_OFFLINE,
  FAKE_PLUG_ONLINE,
  FAKE_PLUG_STATE_UNKNOWN,
  FakeWyzeTransport,
  fakeAccessTokenExpiredEnvelope,
  fakeGetObjectListEnvelope,
  fakeInvalidCredentialsEnvelope,
  fakeMfaSmsChallengeEnvelope,
  fakeMfaTotpChallengeEnvelope,
  fakePropertyListEnvelope,
  fakeSetPropertyEnvelope,
  fakeSuccessEnvelope,
} from "../../src/transport-fake.ts";
import { decodeP3, decodeP5 } from "../../src/plug.ts";
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

  test("getPropertyList defaults to a synthetic ON/reachable property-list envelope", async () => {
    const transport = new FakeWyzeTransport();
    const envelope = await transport.getPropertyList({ accessToken: "at", mac: "m", model: "md", targetPids: ["P3", "P5"] });
    expect(isSuccessEnvelope(envelope)).toBe(true);
  });

  test("setProperty defaults to a success envelope", async () => {
    const transport = new FakeWyzeTransport();
    const envelope = await transport.setProperty({ accessToken: "at", mac: "m", model: "md", pid: "P3", value: 1 });
    expect(isSuccessEnvelope(envelope)).toBe(true);
  });
});

// WYZR-13's fixture-enrichment requirement: WYZR-6's original fixture could
// only ever express "unknown" (no conn_state field at all), which meant
// nothing in this repo could exercise the online/offline distinction this
// story's plug commands depend on. These prove the enriched fixture can now
// express all three.
describe("fakeGetObjectListEnvelope — can express ONLINE, OFFLINE, and UNKNOWN devices", () => {
  test("FAKE_PLUG_ONLINE produces conn_state: 1", () => {
    const envelope = fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: "MAC-ON" }]);
    const device = (envelope.data as { device_list: Array<{ conn_state: unknown }> }).device_list[0]!;
    expect(device.conn_state).toBe(1);
  });

  test("FAKE_PLUG_OFFLINE produces conn_state: 0", () => {
    const envelope = fakeGetObjectListEnvelope([{ ...FAKE_PLUG_OFFLINE, mac: "MAC-OFF" }]);
    const device = (envelope.data as { device_list: Array<{ conn_state: unknown }> }).device_list[0]!;
    expect(device.conn_state).toBe(0);
  });

  test("FAKE_PLUG_STATE_UNKNOWN omits conn_state entirely (matches the original fixture gap)", () => {
    const envelope = fakeGetObjectListEnvelope([{ ...FAKE_PLUG_STATE_UNKNOWN, mac: "MAC-UNK" }]);
    const device = (envelope.data as { device_list: Array<Record<string, unknown>> }).device_list[0]!;
    expect("conn_state" in device).toBe(false);
  });

  test("supports multiple devices in one call, each independently configured", () => {
    const envelope = fakeGetObjectListEnvelope([
      { ...FAKE_PLUG_ONLINE, mac: "MAC-A", nickname: "A" },
      { ...FAKE_PLUG_OFFLINE, mac: "MAC-B", nickname: "B" },
    ]);
    const list = (envelope.data as { device_list: Array<{ mac: string; nickname: string }> }).device_list;
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.mac)).toEqual(["MAC-A", "MAC-B"]);
  });

  test("no-arg call still produces the original single-device, unlabeled-state shape", () => {
    const envelope = fakeGetObjectListEnvelope();
    const list = (envelope.data as { device_list: Array<Record<string, unknown>> }).device_list;
    expect(list).toHaveLength(1);
    expect("conn_state" in list[0]!).toBe(false);
  });
});

describe("fakePropertyListEnvelope — synthetic get_property_list fixture", () => {
  test("defaults to P3=1 (on) / P5=1 (reachable)", () => {
    const envelope = fakePropertyListEnvelope();
    const list = (envelope.data as { property_list: Array<{ pid: string; value: unknown }> }).property_list;
    expect(decodeP3(list.find((e) => e.pid === "P3")?.value)).toBe("on");
    expect(decodeP5(list.find((e) => e.pid === "P5")?.value)).toBe(true);
  });

  test("can express off / unreachable / a missing pid / a boolean wire value", () => {
    const off = fakePropertyListEnvelope({ P3: 0, P5: 0 });
    const offList = (off.data as { property_list: Array<{ pid: string; value: unknown }> }).property_list;
    expect(decodeP3(offList.find((e) => e.pid === "P3")?.value)).toBe("off");
    expect(decodeP5(offList.find((e) => e.pid === "P5")?.value)).toBe(false);

    const missingP5 = fakePropertyListEnvelope({ P3: 1 });
    const missingList = (missingP5.data as { property_list: Array<{ pid: string }> }).property_list;
    expect(missingList.some((e) => e.pid === "P5")).toBe(false);

    const boolWire = fakePropertyListEnvelope({ P3: true });
    const boolList = (boolWire.data as { property_list: Array<{ pid: string; value: unknown }> }).property_list;
    expect(decodeP3(boolList.find((e) => e.pid === "P3")?.value)).toBe("unknown");
  });
});

describe("fakeSetPropertyEnvelope — synthetic set_property fixture", () => {
  test("is a success envelope", () => {
    expect(isSuccessEnvelope(fakeSetPropertyEnvelope())).toBe(true);
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
