import { describe, expect, test } from "bun:test";
import {
  DEVICE_LIST_SCHEMA_VERSION,
  formatDeviceListHuman,
  projectDeviceList,
  type DeviceRecord,
} from "../../src/devices.ts";
import { CliError, ExitCode } from "../../src/errors.ts";

async function expectCliError(fn: () => unknown): Promise<CliError> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected the call to throw a CliError");
}

describe("DEVICE_LIST_SCHEMA_VERSION", () => {
  test("is a stable, documented positive integer", () => {
    expect(DEVICE_LIST_SCHEMA_VERSION).toBe(1);
  });
});

describe("projectDeviceList — happy path", () => {
  test("projects mac/model/name/isPlug/state from a well-formed entry", () => {
    const devices = projectDeviceList({
      device_list: [
        { mac: "FAKE0000MAC0", product_model: "WLPP1", nickname: "Garage Plug", conn_state: 1 },
      ],
    });

    expect(devices).toEqual([
      { mac: "FAKE0000MAC0", model: "WLPP1", name: "Garage Plug", isPlug: true, state: "online", note: null },
    ]);
  });

  test("conn_state 0 (as a number or a string) means offline", () => {
    for (const value of [0, "0"]) {
      const [device] = projectDeviceList({
        device_list: [{ mac: "m", product_model: "WLPP1", nickname: "n", conn_state: value }],
      });
      expect(device!.state).toBe("offline");
    }
  });

  test("conn_state 1 (as a number or a string) means online", () => {
    for (const value of [1, "1"]) {
      const [device] = projectDeviceList({
        device_list: [{ mac: "m", product_model: "WLPP1", nickname: "n", conn_state: value }],
      });
      expect(device!.state).toBe("online");
    }
  });

  test("an unrecognized product_model is marked isPlug: false, not dropped", () => {
    const devices = projectDeviceList({
      device_list: [{ mac: "m", product_model: "SOME_CAMERA_MODEL", nickname: "Front Cam", conn_state: 1 }],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.isPlug).toBe(false);
  });

  test("an empty device_list projects to an empty array, not an error", () => {
    expect(projectDeviceList({ device_list: [] })).toEqual([]);
  });
});

describe("projectDeviceList — malformed per-row data: partial row with a marker, never dropped, never a crash", () => {
  test("a missing mac produces a null mac and a note, but the row still appears", () => {
    const [device] = projectDeviceList({
      device_list: [{ product_model: "WLPP1", nickname: "n", conn_state: 1 }],
    });
    expect(device!.mac).toBeNull();
    expect(device!.note).toContain('"mac"');
  });

  test("a wrong-typed mac (number, not string) produces a null mac and a note", () => {
    const [device] = projectDeviceList({
      device_list: [{ mac: 12345, product_model: "WLPP1", nickname: "n", conn_state: 1 }],
    });
    expect(device!.mac).toBeNull();
    expect(device!.note).toContain('"mac"');
  });

  test("a missing nickname falls back to a placeholder name, not a blank/undefined one", () => {
    const [device] = projectDeviceList({
      device_list: [{ mac: "m", product_model: "WLPP1", conn_state: 1 }],
    });
    expect(device!.name).toBe("(unnamed device)");
  });

  test("a missing conn_state falls back to state: unknown, with a note", () => {
    const [device] = projectDeviceList({
      device_list: [{ mac: "m", product_model: "WLPP1", nickname: "n" }],
    });
    expect(device!.state).toBe("unknown");
    expect(device!.note).toContain('"conn_state"');
  });

  test("a non-object entry in device_list produces a fully-marked placeholder row, not a thrown error", () => {
    const devices = projectDeviceList({ device_list: [null, "not an object", 42] });
    expect(devices).toHaveLength(3);
    for (const device of devices) {
      expect(device.mac).toBeNull();
      expect(device.name).toBe("(malformed device entry)");
      expect(device.state).toBe("unknown");
      expect(device.note).not.toBeNull();
    }
  });

  test("one malformed row among well-formed rows: only that row is marked, the rest are untouched", () => {
    const devices = projectDeviceList({
      device_list: [
        { mac: "m1", product_model: "WLPP1", nickname: "Good Plug", conn_state: 1 },
        { product_model: "WLPP1", nickname: "Bad Plug", conn_state: 1 }, // missing mac
        { mac: "m3", product_model: "WLPP1", nickname: "Also Good", conn_state: 0 },
      ],
    });
    expect(devices).toHaveLength(3);
    expect(devices[0]!.note).toBeNull();
    expect(devices[1]!.note).not.toBeNull();
    expect(devices[2]!.note).toBeNull();
  });
});

describe("projectDeviceList — hard failure only when nothing per-row is salvageable", () => {
  test("data that is not an object throws a documented CliError, ApiError exit code", async () => {
    const err = await expectCliError(() => projectDeviceList("just a string"));
    expect(err.exitCode).toBe(ExitCode.ApiError);
    expect(err.reason).toBe("wyze_device_list_malformed");
  });

  test("an object with no device_list array throws the same documented error", async () => {
    const err = await expectCliError(() => projectDeviceList({ nope: [] }));
    expect(err.reason).toBe("wyze_device_list_malformed");
  });

  test("null data throws the same documented error", async () => {
    const err = await expectCliError(() => projectDeviceList(null));
    expect(err.reason).toBe("wyze_device_list_malformed");
  });
});

// The ticket's hardest rule: build the output object by NAMING each field
// to expose, never by spreading the API object and deleting what is
// unwanted — a denylist silently leaks whatever the API adds tomorrow.
// Run red-first (see PR body for the exact failing output observed when
// projectDevice() in src/devices.ts was temporarily switched to
// `{ ...obj }` plus a delete of the known-bad fields, which is exactly
// what this test exists to catch).
describe("projectDeviceList — allowlist, not denylist (run red-first)", () => {
  test("an unexpected token-shaped field on a device entry never reaches the projected output", () => {
    const devices = projectDeviceList({
      device_list: [
        {
          mac: "m",
          product_model: "WLPP1",
          nickname: "n",
          conn_state: 1,
          // Fields no allowlisted output field names — exactly the shape
          // the finding warns reverse-engineered APIs routinely add.
          access_token: "should-never-reach-output-abc123",
          refresh_token: "should-never-reach-output-def456",
          user_id: "should-never-reach-output-account-id",
        },
      ],
    });

    const serialized = JSON.stringify(devices);
    expect(serialized).not.toContain("should-never-reach-output");
    expect(Object.keys(devices[0] as unknown as Record<string, unknown>).toSorted()).toEqual(
      ["isPlug", "mac", "model", "name", "note", "state"].toSorted(),
    );
  });
});

// Item 5's fragment-safety rule, applied to THIS module's own diagnostics:
// an error/note about a malformed field may name the field and what was
// expected, and may report a TYPE — never any part of the field's actual
// value, not a whole value and not a fragment of one. Run red-first (see
// PR body for the exact failing output observed when fieldNote() in
// src/devices.ts was temporarily changed to interpolate the raw value
// instead of describeType(value) — mirroring WYZR-11's exact
// `Invalid base32 character: "X"` bug shape).
describe("projectDeviceList — malformed-field notes never reproduce the field's value (run red-first)", () => {
  test("a wrong-typed conn_state holding a token-shaped string never appears in the note", () => {
    const secretShapedValue = "wyze_live_secret_fragment_should_never_appear_000";
    const [device] = projectDeviceList({
      device_list: [{ mac: "m", product_model: "WLPP1", nickname: "n", conn_state: secretShapedValue }],
    });

    expect(device!.state).toBe("unknown");
    expect(device!.note).not.toBeNull();
    expect(device!.note).not.toContain(secretShapedValue);
    // Not even a fragment/prefix of it — the exact failure mode item 5 names.
    expect(device!.note).not.toContain(secretShapedValue.slice(0, 8));
  });

  test("a wrong-typed mac holding a token-shaped value never appears in the note", () => {
    const secretShapedValue = "wyze_live_secret_fragment_should_never_appear_111";
    const [device] = projectDeviceList({
      device_list: [{ mac: { nested: secretShapedValue }, product_model: "WLPP1", nickname: "n", conn_state: 1 }],
    });

    expect(device!.mac).toBeNull();
    expect(JSON.stringify(device!.note)).not.toContain(secretShapedValue);
  });
});

describe("formatDeviceListHuman", () => {
  test("an empty list produces a clear message, not a blank line", () => {
    expect(formatDeviceListHuman([])).toBe("No devices found on this account.");
  });

  test("marks a plug row with [PLUG] and an unrecognized-model row with [?]", () => {
    const devices: DeviceRecord[] = [
      { mac: "m1", model: "WLPP1", name: "Office Plug", isPlug: true, state: "online", note: null },
      { mac: "m2", model: "OTHER", name: "Front Cam", isPlug: false, state: "offline", note: null },
    ];
    const lines = formatDeviceListHuman(devices).split("\n");
    expect(lines[0]).toContain("[PLUG]");
    expect(lines[0]).toContain("Office Plug");
    expect(lines[0]).toContain("online");
    expect(lines[1]).toContain("[?]");
    expect(lines[1]).toContain("Front Cam");
    expect(lines[1]).toContain("offline");
  });

  test("a null mac/model render as clear placeholders, not the literal string 'null'", () => {
    const devices: DeviceRecord[] = [
      { mac: null, model: null, name: "(unnamed device)", isPlug: false, state: "unknown", note: "field \"mac\": expected a non-empty string, got undefined" },
    ];
    const line = formatDeviceListHuman(devices);
    expect(line).not.toContain("null");
    expect(line).toContain("(no identifier)");
    expect(line).toContain("(unknown model)");
  });
});
