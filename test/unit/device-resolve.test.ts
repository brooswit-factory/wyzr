// Unit tests for src/device-resolve.ts — decision (C)'s "never guess, ever"
// rules. Pure function over DeviceRecord[], zero network, zero credentials.

import { describe, expect, test } from "bun:test";
import { resolveDevice } from "../../src/device-resolve.ts";
import type { DeviceRecord } from "../../src/devices.ts";
import { CliError, ExitCode } from "../../src/errors.ts";

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    mac: "AB12CD34EF56",
    model: "WLPP1",
    name: "Garage Plug",
    isPlug: true,
    state: "online",
    note: null,
    ...overrides,
  };
}

async function expectCliError(fn: () => void): Promise<CliError> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected resolveDevice to throw a CliError");
}

describe("resolveDevice — matching by mac", () => {
  test("matches mac case-insensitively, exact only", () => {
    const devices = [device({ mac: "AB12CD34EF56" })];
    expect(resolveDevice(devices, "ab12cd34ef56")).toEqual({
      mac: "AB12CD34EF56",
      model: "WLPP1",
      name: "Garage Plug",
    });
  });

  test("does NOT prefix-match a mac", async () => {
    const devices = [device({ mac: "AB12CD34EF56" })];
    const err = await expectCliError(() => resolveDevice(devices, "AB12"));
    expect(err.exitCode).toBe(ExitCode.NotFound);
  });

  test("does NOT substring-match a mac", async () => {
    const devices = [device({ mac: "AB12CD34EF56" })];
    const err = await expectCliError(() => resolveDevice(devices, "12CD34"));
    expect(err.exitCode).toBe(ExitCode.NotFound);
  });
});

describe("resolveDevice — matching by name", () => {
  test("matches name case-insensitively, exact only", () => {
    const devices = [device({ name: "Garage Plug" })];
    expect(resolveDevice(devices, "GARAGE PLUG").name).toBe("Garage Plug");
  });

  test("does NOT fuzzy/substring-match a name", async () => {
    const devices = [device({ name: "Garage Plug" })];
    const err = await expectCliError(() => resolveDevice(devices, "Garage"));
    expect(err.exitCode).toBe(ExitCode.NotFound);
  });
});

describe("resolveDevice — zero matches", () => {
  test("throws not_found (4) naming the reason", async () => {
    const err = await expectCliError(() => resolveDevice([device()], "no-such-device"));
    expect(err.exitCode).toBe(ExitCode.NotFound);
    expect(err.reason).toBe("device_not_found");
  });
});

describe("resolveDevice — ambiguous matches (decision C's central rule)", () => {
  test("two devices matching by name -> ambiguous_device (8), listing every match", async () => {
    const devices = [
      device({ mac: "MAC0000000A", name: "Plug" }),
      device({ mac: "MAC0000000B", name: "plug" }),
    ];
    const err = await expectCliError(() => resolveDevice(devices, "PLUG"));
    expect(err.exitCode).toBe(ExitCode.AmbiguousDevice);
    expect(err.reason).toBe("device_ambiguous");
    expect(err.message).toContain("MAC0000000A");
    expect(err.message).toContain("MAC0000000B");
  });

  // Ticket requirement 5 / decision (C)'s explicitly named trap: "An
  // argument that matches one device's mac AND a different device's name
  // is AMBIGUOUS, not a mac-wins precedence."
  test("query matches one device's mac AND a different device's name -> ambiguous, never mac-wins", async () => {
    const devices = [
      device({ mac: "SHARED-VALUE", name: "Office Plug" }),
      device({ mac: "MAC0000000B", name: "SHARED-VALUE" }),
    ];
    const err = await expectCliError(() => resolveDevice(devices, "shared-value"));
    expect(err.exitCode).toBe(ExitCode.AmbiguousDevice);
    expect(err.message).toContain("Office Plug");
    expect(err.message).toContain("MAC0000000B");
  });

  test("never silently picks one of the ambiguous matches", () => {
    const devices = [
      device({ mac: "MAC0000000A", name: "Plug" }),
      device({ mac: "MAC0000000B", name: "Plug" }),
    ];
    expect(() => resolveDevice(devices, "Plug")).toThrow();
  });
});

describe("resolveDevice — resolved device missing mac or model (partial-row case)", () => {
  test("mac null -> a clear error naming the missing field, never sends a request", async () => {
    const devices = [device({ mac: null, name: "Partial Plug" })];
    const err = await expectCliError(() => resolveDevice(devices, "Partial Plug"));
    expect(err.reason).toBe("device_missing_mac");
    expect(err.message).toContain("mac");
  });

  test("model null -> a clear error naming the missing field", async () => {
    const devices = [device({ model: null, name: "Partial Plug" })];
    const err = await expectCliError(() => resolveDevice(devices, "Partial Plug"));
    expect(err.reason).toBe("device_missing_model");
    expect(err.message).toContain("model");
  });
});
