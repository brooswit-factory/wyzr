import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { printError, printHuman, printJson, printJsonError } from "../../src/output.ts";
import { REDACTED, redact, registerSecret, resetSecretsForTesting } from "../../src/redact.ts";

afterEach(() => {
  resetSecretsForTesting();
});

describe("redact — registered secrets", () => {
  test("scrubs a registered secret value from text", () => {
    registerSecret("super-secret-token-123");
    expect(redact("token=super-secret-token-123")).toBe(`token=${REDACTED}`);
  });

  test("scrubs every occurrence of a registered secret", () => {
    registerSecret("dupe-token");
    expect(redact("dupe-token ... dupe-token")).toBe(`${REDACTED} ... ${REDACTED}`);
  });

  test("leaves text with no secrets unchanged", () => {
    expect(redact("hello world")).toBe("hello world");
  });

  // Real bug shape: an unset credential registers the empty string, every
  // string contains the empty string, and every character of every message
  // gets redacted. registerSecret() must guard against this.
  test("registering an empty string is a no-op", () => {
    registerSecret("");
    expect(redact("hello world")).toBe("hello world");
  });

  test("registering undefined is a no-op", () => {
    registerSecret(undefined);
    expect(redact("hello world")).toBe("hello world");
  });

  test("registering null is a no-op", () => {
    registerSecret(null);
    expect(redact("hello world")).toBe("hello world");
  });

  test("resetSecretsForTesting clears prior registrations", () => {
    registerSecret("leaky-token");
    resetSecretsForTesting();
    expect(redact("token=leaky-token")).toBe("token=leaky-token");
  });
});

describe("redact — generic credential shapes (never registered)", () => {
  test("scrubs an Authorization: Bearer header", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  test("scrubs an Authorization header without Bearer", () => {
    expect(redact("Authorization: raw-key-value-xyz")).toBe(`Authorization: ${REDACTED}`);
  });

  test("scrubs an X-API-Key header, case-insensitively", () => {
    expect(redact("x-api-key: wyze-key-123")).toBe(`x-api-key: ${REDACTED}`);
  });

  test("scrubs an Apikey header", () => {
    expect(redact("Apikey: wyze-key-abc")).toBe(`Apikey: ${REDACTED}`);
  });

  test("scrubs a Keyid header", () => {
    expect(redact("Keyid: wyze-keyid-abc")).toBe(`Keyid: ${REDACTED}`);
  });

  test("scrubs a JSON access_token field", () => {
    expect(redact('{"access_token":"at_live_zzz999"}')).toBe(`{"access_token":"${REDACTED}"}`);
  });

  test("scrubs a JSON refresh_token field with spaces after the colon", () => {
    expect(redact('{"refresh_token": "rt_live_zzz999"}')).toBe(`{"refresh_token": "${REDACTED}"}`);
  });

  test("does not double-redact an Authorization: Bearer header via the generic Authorization pattern", () => {
    const out = redact("Authorization: Bearer secret-value");
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(out.match(/REDACTED/g)?.length).toBe(1);
  });
});

describe("redaction at the print boundary", () => {
  test("a token embedded in a thrown error's message never reaches stderr", () => {
    const token = "wyze_live_abcdef1234567890";
    registerSecret(token);
    const err = new Error(`request failed: Authorization: Bearer ${token}`);

    const spy = spyOn(console, "error").mockImplementation(() => {});
    printError(err.message);
    const printed = spy.mock.calls.map((call) => String(call[0])).join("\n");
    spy.mockRestore();

    expect(printed).not.toContain(token);
    expect(printed).toContain(REDACTED);
  });

  test("printJson redacts a secret embedded anywhere in the serialized value", () => {
    const token = "wyze_live_zzz999";
    registerSecret(token);

    const spy = spyOn(console, "log").mockImplementation(() => {});
    printJson({ note: `token was ${token}` });
    const printed = spy.mock.calls.map((call) => String(call[0])).join("\n");
    spy.mockRestore();

    expect(printed).not.toContain(token);
    expect(printed).toContain(REDACTED);
  });

  test("printJsonError redacts a secret in a dumped request, even unregistered header shapes", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    printJsonError({
      error: {
        message: "request failed",
        debugRequest: { headers: { Authorization: "Bearer never-registered-secret" } },
      },
    });
    const printed = spy.mock.calls.map((call) => String(call[0])).join("\n");
    spy.mockRestore();

    expect(printed).not.toContain("never-registered-secret");
    expect(printed).toContain(REDACTED);
  });

  test("an empty-string registration does not blank out unrelated printed output", () => {
    registerSecret("");
    registerSecret(undefined);

    const spy = spyOn(console, "log").mockImplementation(() => {});
    printHuman("device-123 is ON");
    const printed = spy.mock.calls.map((call) => String(call[0])).join("\n");
    spy.mockRestore();

    expect(printed).toBe("device-123 is ON");
  });
});
