import { describe, expect, test } from "bun:test";
import { wyzeTripleMd5 } from "../../src/wyze-auth-hash.ts";
import { createHash } from "node:crypto";

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

describe("wyzeTripleMd5", () => {
  test("applies MD5 three times, not once or twice", () => {
    const password = "fake-test-password-000";
    const once = md5(password);
    const twice = md5(once);
    const thrice = md5(twice);

    const result = wyzeTripleMd5(password);
    expect(result).toBe(thrice);
    expect(result).not.toBe(once);
    expect(result).not.toBe(twice);
  });

  test("never returns the raw password", () => {
    const password = "fake-test-password-000";
    expect(wyzeTripleMd5(password)).not.toBe(password);
  });

  test("is deterministic for the same input", () => {
    expect(wyzeTripleMd5("same-input")).toBe(wyzeTripleMd5("same-input"));
  });

  test("different passwords hash differently", () => {
    expect(wyzeTripleMd5("password-a")).not.toBe(wyzeTripleMd5("password-b"));
  });

  test("output is a 32-character lowercase hex string (MD5 hex digest shape)", () => {
    expect(wyzeTripleMd5("anything")).toMatch(/^[0-9a-f]{32}$/);
  });
});
