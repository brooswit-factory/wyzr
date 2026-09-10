import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DEVICE_PHONE_ID,
  DEVICE_PHONE_ID_SEED,
  DEVICE_STANDARD_BODY_APP_NAME,
  DEVICE_STANDARD_BODY_APP_VER,
  DEVICE_STANDARD_BODY_APP_VERSION,
  DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE,
  DEVICE_STANDARD_BODY_SC,
  DEVICE_STANDARD_BODY_SV,
  deviceStandardBody,
} from "../../src/wyze-device-identity.ts";

describe("DEVICE_PHONE_ID", () => {
  test("is the SHA-256 hex digest of DEVICE_PHONE_ID_SEED", () => {
    const expected = createHash("sha256").update(DEVICE_PHONE_ID_SEED, "utf8").digest("hex");
    expect(DEVICE_PHONE_ID).toBe(expected);
  });

  test("is a 64-character lowercase hex string (SHA-256 hex digest shape)", () => {
    expect(DEVICE_PHONE_ID).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the seed names this project", () => {
    expect(DEVICE_PHONE_ID_SEED).toContain("wyzr");
  });
});

describe("deviceStandardBody", () => {
  test("includes every measured field, sc/sv/app_ver/app_name/app_version/phone_system_type as the measured constants", () => {
    const body = deviceStandardBody(() => 1_700_000_000_000);
    expect(body).toEqual({
      sc: DEVICE_STANDARD_BODY_SC,
      sv: DEVICE_STANDARD_BODY_SV,
      app_ver: DEVICE_STANDARD_BODY_APP_VER,
      app_name: DEVICE_STANDARD_BODY_APP_NAME,
      app_version: DEVICE_STANDARD_BODY_APP_VERSION,
      phone_id: DEVICE_PHONE_ID,
      phone_system_type: DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE,
      ts: 1_700_000_000_000,
    });
  });

  test("phone_system_type is the STRING \"1\", matching the measured transcript's quoting", () => {
    expect(deviceStandardBody().phone_system_type).toBe("1");
  });

  test("ts is a bare JSON number, not a string, matching the measured transcript's unquoted ts", () => {
    expect(typeof deviceStandardBody(() => 42).ts).toBe("number");
  });

  test("ts defaults to the wall clock when no clock is injected", () => {
    const before = Date.now();
    const ts = deviceStandardBody().ts as number;
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
