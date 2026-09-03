// End-to-end tests for `wyzr devices list`'s wiring (src/cli-devices.ts):
// WyzeAuthSession + src/devices.ts's projection + src/output.ts, all
// against FakeWyzeTransport and fixture credentials. Zero credentials
// file, zero network, per the ticket's explicit requirement — nothing
// here touches loadCredentials() or the real filesystem/HOME.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runDevicesList } from "../../src/cli-devices.ts";
import type { Credentials } from "../../src/credentials.ts";
import { DEVICE_LIST_SCHEMA_VERSION } from "../../src/devices.ts";
import { ExitCode } from "../../src/errors.ts";
import { registerSecret, resetSecretsForTesting } from "../../src/redact.ts";
import { FakeWyzeTransport, fakeSuccessEnvelope } from "../../src/transport-fake.ts";
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

function fakeDeviceListEnvelope(deviceOverrides: Record<string, unknown> = {}): WyzeEnvelope {
  return {
    code: "1",
    msg: "",
    data: {
      device_list: [
        {
          mac: "FAKE0000MAC0",
          product_model: "WLPP1",
          nickname: "fake synthetic plug — not a real device",
          conn_state: 1,
          ...deviceOverrides,
        },
      ],
    },
  };
}

describe("runDevicesList — end to end against the fake transport, zero credentials, zero network", () => {
  test("human mode prints the formatted device list and returns Ok", async () => {
    const transport = new FakeWyzeTransport({ getObjectListHandler: () => fakeDeviceListEnvelope() });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runDevicesList({ transport, credentials: FAKE_CREDS }, false);

    expect(code).toBe(ExitCode.Ok);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).toContain("[PLUG]");
    expect(printed).toContain("FAKE0000MAC0");
    logSpy.mockRestore();
  });

  test("--json mode prints {schemaVersion, devices} matching the documented contract", async () => {
    const transport = new FakeWyzeTransport({ getObjectListHandler: () => fakeDeviceListEnvelope() });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runDevicesList({ transport, credentials: FAKE_CREDS }, true);

    expect(code).toBe(ExitCode.Ok);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed).toEqual({
      schemaVersion: DEVICE_LIST_SCHEMA_VERSION,
      devices: [
        {
          mac: "FAKE0000MAC0",
          model: "WLPP1",
          name: "fake synthetic plug — not a real device",
          isPlug: true,
          state: "online",
          note: null,
        },
      ],
    });
    logSpy.mockRestore();
  });

  test("works against FakeWyzeTransport's own default handlers too (no override needed)", async () => {
    const transport = new FakeWyzeTransport();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runDevicesList({ transport, credentials: FAKE_CREDS }, true);

    expect(code).toBe(ExitCode.Ok);
    logSpy.mockRestore();
  });

  test("an empty account (no devices) prints a clear message, not an error", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => ({ code: "1", msg: "", data: { device_list: [] } }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runDevicesList({ transport, credentials: FAKE_CREDS }, false);

    expect(code).toBe(ExitCode.Ok);
    expect(String(logSpy.mock.calls[0]![0])).toContain("No devices found");
    logSpy.mockRestore();
  });
});

// Verification-discipline requirement: exercise the listing path with a
// secret registered in the redaction registry AND a token-shaped value
// present in the fake's get_object_list response, and prove neither ever
// reaches printed output. Run red-first — see the PR body for the exact
// red output observed when src/devices.ts's projectDevice() was
// temporarily switched to a spread-based (denylist) implementation for
// this test.
//
// Deliberately NOT named `access_token`/`refresh_token`/`Authorization`/
// etc: those specific shapes are already caught by src/redact.ts's own
// generic CREDENTIAL_PATTERNS backstop regardless of this story's code, so
// using them here would not actually prove THIS module's allowlist is
// doing the work. `user_id`/`home_id` below are unregistered,
// account-identifier-shaped fields the finding warns get returned
// unasked-for, and are not covered by any existing redact.ts pattern —
// only this module's allowlist can keep them out.
describe("runDevicesList — no secret or unexpected account-identifier field ever reaches printed output (run red-first)", () => {
  test("human mode", async () => {
    registerSecret(FAKE_CREDS.password); // what loadCredentials() does for real usage
    const canary = "canary-account-identifier-should-never-print-000";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeDeviceListEnvelope({ user_id: canary, home_id: canary }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runDevicesList({ transport, credentials: FAKE_CREDS }, false);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).not.toContain(FAKE_CREDS.password);
    expect(printed).not.toContain(canary);
    logSpy.mockRestore();
  });

  test("--json mode", async () => {
    registerSecret(FAKE_CREDS.password);
    const canary = "canary-account-identifier-should-never-print-111";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeDeviceListEnvelope({ user_id: canary, home_id: canary }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runDevicesList({ transport, credentials: FAKE_CREDS }, true);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).not.toContain(FAKE_CREDS.password);
    expect(printed).not.toContain(canary);
    logSpy.mockRestore();
  });

  // Defense-in-depth check on src/redact.ts's existing backstop (not this
  // story's new allowlist): the real session's own access/refresh tokens
  // from login() are registered by src/auth-session.ts the instant they
  // are received, so even if something upstream ever changed, redact()
  // still catches them.
  test("the real session tokens obtained via login() are also never printed", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () =>
        fakeSuccessEnvelope({ accessToken: "session-at-canary-000", refreshToken: "session-rt-canary-000" }),
      getObjectListHandler: () => fakeDeviceListEnvelope(),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runDevicesList({ transport, credentials: FAKE_CREDS }, true);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).not.toContain("session-at-canary-000");
    expect(printed).not.toContain("session-rt-canary-000");
    logSpy.mockRestore();
  });
});

describe("runDevicesList — errors propagate uncaught for src/cli.ts's boundary to map", () => {
  test("a login failure (e.g. invalid credentials) throws rather than being swallowed", async () => {
    const transport = new FakeWyzeTransport({
      loginHandler: () => ({ code: 1000, msg: "wrong password or apikey", data: {} }),
    });
    await expect(runDevicesList({ transport, credentials: FAKE_CREDS }, false)).rejects.toThrow();
  });

  test("a malformed device-list response (not shaped as a device list at all) throws rather than printing raw data", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => ({ code: "1", msg: "", data: { not_a_device_list: true } }),
    });
    await expect(runDevicesList({ transport, credentials: FAKE_CREDS }, false)).rejects.toThrow();
  });
});
