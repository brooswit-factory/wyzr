// End-to-end tests for `wyzr plug status|on|off`'s wiring (src/cli-plug.ts)
// against FakeWyzeTransport and fixture credentials. Zero credentials file,
// zero network — nothing here touches loadCredentials() or the real
// filesystem/HOME.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runPlugStatus, runPlugWrite } from "../../src/cli-plug.ts";
import type { Credentials } from "../../src/credentials.ts";
import { ExitCode } from "../../src/errors.ts";
import { registerSecret, resetSecretsForTesting } from "../../src/redact.ts";
import {
  FAKE_PLUG_OFFLINE,
  FAKE_PLUG_ONLINE,
  FakeWyzeTransport,
  fakeGetObjectListEnvelope,
  fakePropertyListEnvelope,
  fakeSetPropertyEnvelope,
} from "../../src/transport-fake.ts";
import type { GetPropertyListRequest, SetPropertyRequest } from "../../src/transport.ts";
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

const ONE_PLUG = [{ ...FAKE_PLUG_ONLINE, mac: "FAKE0000MAC0", nickname: "Garage Plug" }];

function silence(): { restore: () => void } {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  return { restore: () => logSpy.mockRestore() };
}

describe("runPlugStatus", () => {
  test("a fully known reading (P3 and P5 both decodable) exits Ok, human and --json", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 1, P5: 1 }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugStatus({ transport, credentials: FAKE_CREDS }, "Garage Plug", false);

    expect(code).toBe(ExitCode.Ok);
    expect(String(logSpy.mock.calls[0]![0])).toContain("ON");
    logSpy.mockRestore();
  });

  test("--json matches the documented PlugStatusJson contract on the happy path", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0, P5: 1 }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugStatus({ transport, credentials: FAKE_CREDS }, "FAKE0000MAC0", true);

    expect(code).toBe(ExitCode.Ok);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed).toEqual({
      schemaVersion: 1,
      command: "plug status",
      device: { mac: "FAKE0000MAC0", model: "WLPP1", name: "Garage Plug" },
      power: "off",
      reachable: true,
      note: null,
    });
    logSpy.mockRestore();
  });

  // Decision (F2): a genuinely undetermined reading is an OUTCOME, not an
  // error — it prints the normal payload and returns the code, never throws.
  test("P5 undecodable -> exits StateUnknown (9), prints the normal payload, does NOT throw", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0 }), // P5 absent
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugStatus({ transport, credentials: FAKE_CREDS }, "Garage Plug", true);

    expect(code).toBe(ExitCode.StateUnknown);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed.power).toBe("off");
    expect(printed.reachable).toBeNull();
    logSpy.mockRestore();
  });

  test("human output never prints a bare OFF when the reading is undetermined", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0 }), // P5 absent -> unknown
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugStatus({ transport, credentials: FAKE_CREDS }, "Garage Plug", false);

    expect(code).toBe(ExitCode.StateUnknown);
    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).toContain("STATE UNKNOWN");
    expect(printed).not.toMatch(/:\s*OFF\b/);
    logSpy.mockRestore();
  });

  // Decision (F2): a genuine transport failure (nothing observed) IS an
  // error, not an outcome.
  test("a transport failure on the property-list read propagates as a real error, not state_unknown", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: () => {
        throw new Error("simulated transport failure");
      },
    });
    await expect(
      runPlugStatus({ transport, credentials: FAKE_CREDS }, "Garage Plug", false),
    ).rejects.toThrow(/simulated transport failure/);
  });

  test("device not found propagates uncaught (error, not an outcome)", async () => {
    const transport = new FakeWyzeTransport({ getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG) });
    await expect(
      runPlugStatus({ transport, credentials: FAKE_CREDS }, "no-such-device", false),
    ).rejects.toThrow();
  });

  test("ambiguous device propagates uncaught, and no property-list call is ever made", async () => {
    const twoPlugsSameName = [
      { ...FAKE_PLUG_ONLINE, mac: "MAC-A", nickname: "Plug" },
      { ...FAKE_PLUG_OFFLINE, mac: "MAC-B", nickname: "Plug" },
    ];
    let propertyCalls = 0;
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(twoPlugsSameName),
      getPropertyListHandler: () => {
        propertyCalls += 1;
        return fakePropertyListEnvelope();
      },
    });
    await expect(runPlugStatus({ transport, credentials: FAKE_CREDS }, "Plug", false)).rejects.toThrow();
    expect(propertyCalls).toBe(0);
  });
});

describe("runPlugWrite", () => {
  test("confirmed: read-back matches requested -> exits Ok, --json carries the verification object", async () => {
    const setCalls: SetPropertyRequest[] = [];
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: (req) => {
        setCalls.push(req);
        return fakeSetPropertyEnvelope();
      },
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 1, P5: 1 }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", true);

    expect(code).toBe(ExitCode.Ok);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.pid).toBe("P3");
    expect(setCalls[0]!.value).toBe(1); // never `true`
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed).toEqual({
      schemaVersion: 1,
      command: "plug on",
      device: { mac: "FAKE0000MAC0", model: "WLPP1", name: "Garage Plug" },
      requested: "on",
      result: "confirmed",
      observedPower: "on",
      reachable: true,
      verification: { readBacks: 1, waitedMs: 0 },
      note: null,
    });
    logSpy.mockRestore();
  });

  test("plug off sends P3=0, never a boolean", async () => {
    const setCalls: SetPropertyRequest[] = [];
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: (req) => {
        setCalls.push(req);
        return fakeSetPropertyEnvelope();
      },
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0, P5: 1 }),
    });
    const { restore } = silence();

    const code = await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "off", true);

    expect(code).toBe(ExitCode.Ok);
    expect(setCalls[0]!.value).toBe(0);
    restore();
  });

  // Decision (F2): 9/10 are OUTCOME codes — printed, returned, never thrown.
  test("contradicted: read-back disagrees -> exits WriteContradicted (10), prints the normal payload", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => fakeSetPropertyEnvelope(),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0, P5: 1 }), // requested "on", read back "off"
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", true);

    expect(code).toBe(ExitCode.WriteContradicted);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed.result).toBe("contradicted");
    expect(printed.observedPower).toBe("off");
    logSpy.mockRestore();
  });

  test("contradicted human wording never says the write failed", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => fakeSetPropertyEnvelope(),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 0, P5: 1 }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", false);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed.toLowerCase()).not.toMatch(/\bfail(ed|s|ure)?\b/);
    logSpy.mockRestore();
  });

  // Decision (D)/(D2): a read-back that THROWS is caught and becomes
  // "unconfirmed" — never a bare, uncaught transport error, because that
  // would hide that the write was already accepted.
  test("read-back throws -> caught and reported as unconfirmed (StateUnknown, 9), not an uncaught error", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => fakeSetPropertyEnvelope(),
      getPropertyListHandler: () => {
        throw new Error("simulated read-back transport failure");
      },
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", true);

    expect(code).toBe(ExitCode.StateUnknown);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed.result).toBe("unconfirmed");
    expect(printed.observedPower).toBe("unknown");
    logSpy.mockRestore();
  });

  test("unconfirmed human wording says both that the write was accepted and the effect is unknown", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => fakeSetPropertyEnvelope(),
      getPropertyListHandler: () => fakePropertyListEnvelope({}), // neither pid present
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", false);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).toMatch(/accepted/i);
    expect(printed).toMatch(/unknown|could not be read/i);
    logSpy.mockRestore();
  });

  // Decision (F2): a failed WRITE (setProperty itself throws) is a real
  // error — nothing was accepted, so this is not an outcome to report.
  test("setProperty itself throwing propagates as a real error, not an outcome", async () => {
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => {
        throw new Error("simulated write rejection");
      },
    });
    await expect(
      runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", false),
    ).rejects.toThrow(/simulated write rejection/);
  });

  test("ambiguous device propagates uncaught, and no write is ever attempted", async () => {
    const twoPlugsSameName = [
      { ...FAKE_PLUG_ONLINE, mac: "MAC-A", nickname: "Plug" },
      { ...FAKE_PLUG_OFFLINE, mac: "MAC-B", nickname: "Plug" },
    ];
    let setCalls = 0;
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(twoPlugsSameName),
      setPropertyHandler: () => {
        setCalls += 1;
        return fakeSetPropertyEnvelope();
      },
    });
    await expect(runPlugWrite({ transport, credentials: FAKE_CREDS }, "Plug", "on", false)).rejects.toThrow();
    expect(setCalls).toBe(0);
  });
});

describe("no secret or unexpected account-identifier field ever reaches plug output (run red-first)", () => {
  test("plug status", async () => {
    registerSecret(FAKE_CREDS.password);
    const canary = "canary-account-identifier-should-never-print-plug-000";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      getPropertyListHandler: (): WyzeEnvelope => ({
        code: "1",
        msg: "",
        data: { property_list: [{ pid: "P3", value: 1 }, { pid: "P5", value: 1 }], user_id: canary },
      }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runPlugStatus({ transport, credentials: FAKE_CREDS }, "Garage Plug", true);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).not.toContain(FAKE_CREDS.password);
    expect(printed).not.toContain(canary);
    logSpy.mockRestore();
  });

  test("plug on", async () => {
    registerSecret(FAKE_CREDS.password);
    const canary = "canary-account-identifier-should-never-print-plug-111";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope(ONE_PLUG),
      setPropertyHandler: () => fakeSetPropertyEnvelope(),
      getPropertyListHandler: (req: GetPropertyListRequest): WyzeEnvelope => ({
        code: "1",
        msg: "",
        data: { property_list: [{ pid: "P3", value: 1 }, { pid: "P5", value: 1 }], home_id: canary, mac: req.mac },
      }),
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await runPlugWrite({ transport, credentials: FAKE_CREDS }, "Garage Plug", "on", true);

    const printed = String(logSpy.mock.calls[0]![0]);
    expect(printed).not.toContain(FAKE_CREDS.password);
    expect(printed).not.toContain(canary);
    logSpy.mockRestore();
  });
});
