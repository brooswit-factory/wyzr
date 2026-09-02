import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { APP_IDENTITY_KEY, APP_IDENTITY_SEED } from "../../src/app-identity.ts";

describe("APP_IDENTITY_KEY", () => {
  test("is the SHA-256 hex digest of APP_IDENTITY_SEED", () => {
    const expected = createHash("sha256").update(APP_IDENTITY_SEED, "utf8").digest("hex");
    expect(APP_IDENTITY_KEY).toBe(expected);
  });

  test("is a 64-character lowercase hex string (SHA-256 hex digest shape)", () => {
    expect(APP_IDENTITY_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the seed names this project, not any other project's key", () => {
    expect(APP_IDENTITY_SEED).toContain("wyzr");
  });
});
