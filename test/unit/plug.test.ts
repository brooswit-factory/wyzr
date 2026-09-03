// Unit tests for src/plug.ts: P3/P5 decoding, get_property_list parsing,
// the write-verb read-back outcome classification, and human-readable
// formatting. Zero network, zero credentials — everything here is pure
// functions over plain data.

import { describe, expect, test } from "bun:test";
import {
  classifyWriteOutcome,
  decodeP3,
  decodeP5,
  formatPlugStatusHuman,
  formatPlugWriteHuman,
  PLUG_SCHEMA_VERSION,
  readPlugState,
  SINGLE_IMMEDIATE_READ,
  statusExitCode,
  writeResultExitCode,
  type PlugStatusJson,
  type PlugWriteJson,
} from "../../src/plug.ts";
import { ExitCode } from "../../src/errors.ts";

describe("decodeP3 — decision (A): closed, boolean-rejecting whitelist", () => {
  test("accepts the number 1 as on and the number 0 as off", () => {
    expect(decodeP3(1)).toBe("on");
    expect(decodeP3(0)).toBe("off");
  });

  test("accepts the strings \"1\"/\"0\" defensively", () => {
    expect(decodeP3("1")).toBe("on");
    expect(decodeP3("0")).toBe("off");
  });

  // THE RED-FIRST-REQUIRED TEST (ticket: "You must ship a test that fails
  // if the code ever starts accepting a boolean as on/off"). Run this test
  // against a temporarily "helpfully coerced" decodeP3 (e.g. adding
  // `if (value === true) return "on"; if (value === false) return "off";`)
  // to see it go red — see the PR body for the actual red output observed.
  test("REJECTS native JSON booleans — true/false decode to \"unknown\", never on/off", () => {
    expect(decodeP3(true)).toBe("unknown");
    expect(decodeP3(false)).toBe("unknown");
  });

  test("rejects everything else: null, undefined, other numbers, other strings, objects, arrays", () => {
    expect(decodeP3(null)).toBe("unknown");
    expect(decodeP3(undefined)).toBe("unknown");
    expect(decodeP3(2)).toBe("unknown");
    expect(decodeP3(-1)).toBe("unknown");
    expect(decodeP3("on")).toBe("unknown");
    expect(decodeP3("true")).toBe("unknown");
    expect(decodeP3({})).toBe("unknown");
    expect(decodeP3([1])).toBe("unknown");
  });
});

describe("decodeP5 — same closed whitelist, for reachability", () => {
  test("accepts 1/0/\"1\"/\"0\"", () => {
    expect(decodeP5(1)).toBe(true);
    expect(decodeP5(0)).toBe(false);
    expect(decodeP5("1")).toBe(true);
    expect(decodeP5("0")).toBe(false);
  });

  test("REJECTS native JSON booleans", () => {
    expect(decodeP5(true)).toBeNull();
    expect(decodeP5(false)).toBeNull();
  });

  test("rejects everything else to null (undecodable)", () => {
    expect(decodeP5(undefined)).toBeNull();
    expect(decodeP5(null)).toBeNull();
    expect(decodeP5(2)).toBeNull();
    expect(decodeP5("reachable")).toBeNull();
  });
});

function propertyListData(entries: unknown[]): unknown {
  return { property_list: entries };
}

describe("readPlugState — parses get_property_list's data and decodes P3/P5", () => {
  test("both P3 and P5 present and decodable", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: 1 }, { pid: "P5", value: 1 }]));
    expect(reading).toEqual({ power: "on", reachable: true, note: null });
  });

  test("P3 off, P5 reachable", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: 0 }, { pid: "P5", value: 1 }]));
    expect(reading.power).toBe("off");
    expect(reading.reachable).toBe(true);
  });

  test("P3 off, P5 unreachable — both decodable, still a confident reading", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: 0 }, { pid: "P5", value: 0 }]));
    expect(reading.power).toBe("off");
    expect(reading.reachable).toBe(false);
    expect(reading.note).toBeNull();
  });

  test("P3 missing entirely -> power unknown, with a fragment-safe note naming P3", () => {
    const reading = readPlugState(propertyListData([{ pid: "P5", value: 1 }]));
    expect(reading.power).toBe("unknown");
    expect(reading.note).toContain('"P3"');
  });

  test("P5 missing entirely -> reachable null, with a fragment-safe note naming P5", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: 1 }]));
    expect(reading.reachable).toBeNull();
    expect(reading.note).toContain('"P5"');
  });

  // Ticket requirement 4: "A test proves a P3-known/P5-unknown reading does
  // NOT report a confident state" — proven here at the decode level (power
  // decodes fine, reachable is independently null) AND at the exit-code
  // level below (statusExitCode refuses Ok).
  test("P3 known, P5 undecodable (a boolean on the wire) — reachability is NEVER inferred from P3", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: 1 }, { pid: "P5", value: true }]));
    expect(reading.power).toBe("on");
    expect(reading.reachable).toBeNull();
    expect(statusExitCode(reading)).toBe(ExitCode.StateUnknown);
  });

  test("a P3 value that is a boolean on the wire never reports on/off, even with P5 healthy", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: true }, { pid: "P5", value: 1 }]));
    expect(reading.power).toBe("unknown");
    expect(reading.reachable).toBe(true);
  });

  test("no note field never reproduces any part of a field's actual value — only its type", () => {
    const reading = readPlugState(propertyListData([{ pid: "P3", value: "not-a-real-value-token-000" }]));
    expect(reading.note).not.toContain("not-a-real-value-token-000");
    expect(reading.note).toContain("string");
  });

  describe("malformed / unexpected response shapes never throw — they resolve to an unknown reading", () => {
    test("data is not an object at all", () => {
      const reading = readPlugState("not an object");
      expect(reading.power).toBe("unknown");
      expect(reading.reachable).toBeNull();
      expect(reading.note).not.toBeNull();
    });

    test("data has no property_list array", () => {
      const reading = readPlugState({ unexpected_wrapper_key: [] });
      expect(reading.power).toBe("unknown");
      expect(reading.reachable).toBeNull();
    });

    test("an entry in property_list is not an object", () => {
      const reading = readPlugState(propertyListData([null, { pid: "P3", value: 1 }]));
      expect(reading.power).toBe("on");
      expect(reading.note).not.toBeNull();
    });

    test("an entry has a non-string pid", () => {
      const reading = readPlugState(propertyListData([{ pid: 12345, value: 1 }]));
      expect(reading.power).toBe("unknown");
      expect(reading.note).not.toBeNull();
    });
  });
});

describe("classifyWriteOutcome — decision (D)'s three outcomes", () => {
  test("confirmed: read-back power matches requested", () => {
    expect(classifyWriteOutcome("on", { power: "on", reachable: true, note: null })).toBe("confirmed");
    expect(classifyWriteOutcome("off", { power: "off", reachable: true, note: null })).toBe("confirmed");
  });

  test("contradicted: read-back power is the OTHER known value", () => {
    expect(classifyWriteOutcome("on", { power: "off", reachable: true, note: null })).toBe("contradicted");
    expect(classifyWriteOutcome("off", { power: "on", reachable: true, note: null })).toBe("contradicted");
  });

  test("unconfirmed: power undecodable — takes priority over being merely \"not equal\"", () => {
    expect(classifyWriteOutcome("on", { power: "unknown", reachable: null, note: null })).toBe("unconfirmed");
  });
});

describe("writeResultExitCode / statusExitCode — decision (B)/(D)/(E) mapping", () => {
  test("confirmed -> Ok, unconfirmed -> StateUnknown, contradicted -> WriteContradicted", () => {
    expect(writeResultExitCode("confirmed")).toBe(ExitCode.Ok);
    expect(writeResultExitCode("unconfirmed")).toBe(ExitCode.StateUnknown);
    expect(writeResultExitCode("contradicted")).toBe(ExitCode.WriteContradicted);
  });

  test("statusExitCode is Ok only when both power and reachable are decodable", () => {
    expect(statusExitCode({ power: "on", reachable: true, note: null })).toBe(ExitCode.Ok);
    expect(statusExitCode({ power: "off", reachable: false, note: null })).toBe(ExitCode.Ok);
    expect(statusExitCode({ power: "unknown", reachable: true, note: null })).toBe(ExitCode.StateUnknown);
    expect(statusExitCode({ power: "on", reachable: null, note: null })).toBe(ExitCode.StateUnknown);
    expect(statusExitCode({ power: "unknown", reachable: null, note: null })).toBe(ExitCode.StateUnknown);
  });
});

function statusPayload(overrides: Partial<PlugStatusJson> = {}): PlugStatusJson {
  return {
    schemaVersion: PLUG_SCHEMA_VERSION,
    command: "plug status",
    device: { mac: "FAKE0000MAC0", model: "WLPP1", name: "fake synthetic plug" },
    power: "on",
    reachable: true,
    note: null,
    ...overrides,
  };
}

describe("formatPlugStatusHuman — decision (E)'s off-vs-unknown wording rule", () => {
  test("a fully known reading prints the actual state", () => {
    const text = formatPlugStatusHuman(statusPayload({ power: "off", reachable: true }));
    expect(text).toContain("OFF");
    expect(text).toContain("reachable");
  });

  // THE RED-FIRST-REQUIRED TEST for the off-vs-unknown collapse. Run this
  // against a version of formatPlugStatusHuman() that skips the `known`
  // check (always prints `payload.power.toUpperCase()`) to see it go red —
  // see the PR body for the actual red output observed.
  test("power unknown -> STATE UNKNOWN, and the word OFF never appears as a state assertion", () => {
    const text = formatPlugStatusHuman(statusPayload({ power: "unknown", reachable: true }));
    expect(text).toContain("STATE UNKNOWN");
    // The disclaimer sentence is allowed to reference "off" in quotes to
    // explain what unknown is NOT; what must never appear is "off" printed
    // as this reading's reported state (i.e. immediately after the label).
    expect(text).not.toMatch(/:\s*OFF\b/);
  });

  test("reachable undetermined (P5 undecodable) also forces STATE UNKNOWN, even with power decodable", () => {
    const text = formatPlugStatusHuman(statusPayload({ power: "off", reachable: null }));
    expect(text).toContain("STATE UNKNOWN");
    expect(text).not.toMatch(/:\s*OFF\b/);
  });

  test("reachable === false (confirmed unreachable) is NOT state-unknown — it is a decodable value", () => {
    const text = formatPlugStatusHuman(statusPayload({ power: "off", reachable: false }));
    expect(text).not.toContain("STATE UNKNOWN");
    expect(text).toContain("OFF");
    expect(text).toContain("UNREACHABLE");
  });
});

function writePayload(overrides: Partial<PlugWriteJson> = {}): PlugWriteJson {
  return {
    schemaVersion: PLUG_SCHEMA_VERSION,
    command: "plug on",
    device: { mac: "FAKE0000MAC0", model: "WLPP1", name: "fake synthetic plug" },
    requested: "on",
    result: "confirmed",
    observedPower: "on",
    reachable: true,
    verification: SINGLE_IMMEDIATE_READ,
    note: null,
    ...overrides,
  };
}

describe("formatPlugWriteHuman — decision (D2)'s wording rule", () => {
  test("confirmed prints the confirmed state plainly", () => {
    const text = formatPlugWriteHuman(writePayload({ result: "confirmed" }));
    expect(text).toContain("confirmed ON");
  });

  test("unconfirmed says BOTH that the write was accepted AND that the effect is unknown", () => {
    const text = formatPlugWriteHuman(
      writePayload({ result: "unconfirmed", observedPower: "unknown", reachable: null }),
    );
    expect(text).toMatch(/accepted/i);
    expect(text).toMatch(/unknown|could not be read/i);
  });

  // THE WORDING-RULE TEST the ticket explicitly requires (item 8: "A test
  // asserts the wording rule, not just the exit code"). Decision (D2): a
  // contradicted read-back must NEVER be reported as "the write failed" —
  // it is equally consistent with a write that succeeded and simply had
  // not propagated yet.
  test("contradicted NEVER claims the write failed", () => {
    const text = formatPlugWriteHuman(
      writePayload({ result: "contradicted", requested: "on", observedPower: "off" }),
    );
    expect(text.toLowerCase()).not.toMatch(/\bfail(ed|s|ure)?\b/);
    // It must still say plainly what WAS observed.
    expect(text).toContain("OFF");
    expect(text.toLowerCase()).toMatch(/propagation lag|had no effect/);
  });

  test("contradicted for a requested OFF that read back ON is equally non-committal", () => {
    const text = formatPlugWriteHuman(
      writePayload({ result: "contradicted", requested: "off", observedPower: "on" }),
    );
    expect(text.toLowerCase()).not.toMatch(/\bfail(ed|s|ure)?\b/);
  });
});
