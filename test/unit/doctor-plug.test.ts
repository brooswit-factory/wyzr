// src/doctor-plug.ts: the doctor's own read-only plug boundary.
// `checkPlugReadable()` is exercised with FakeCyclePlugTransport
// (src/cycle-plug-fake.ts) — the SAME fake `wyzr cycle`'s own tests use —
// reused rather than a second, doctor-specific fake, per the ticket's own
// "compose, don't re-invent" instruction. `isPlugResolvable()` is exercised
// with hand-built DeviceRecord fixtures, zero I/O.

import { describe, expect, test } from "bun:test";
import { FakeCyclePlugTransport, fakePlugReading } from "../../src/cycle-plug-fake.ts";
import { checkPlugReadable, isPlugResolvable } from "../../src/doctor-plug.ts";
import type { PlugReader } from "../../src/cycle-plug.ts";
import type { DeviceRecord } from "../../src/devices.ts";

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return { mac: "AA:BB:CC:DD:EE:01", model: "WLPP1CFH", name: "fixture-device", isPlug: true, state: "online", note: null, ...overrides };
}

describe("isPlugResolvable", () => {
  test("true when a device in the list has the same mac, case/whitespace-insensitive", () => {
    const devices = [device({ mac: " aa:bb:cc:dd:ee:01 " })];
    expect(isPlugResolvable(devices, "AA:BB:CC:DD:EE:01")).toBe(true);
  });

  test("false when no device matches", () => {
    const devices = [device({ mac: "11:22:33:44:55:66" })];
    expect(isPlugResolvable(devices, "AA:BB:CC:DD:EE:01")).toBe(false);
  });

  test("false against a device list containing only null-mac (partial) rows — never a crash, never a false match", () => {
    const devices = [device({ mac: null })];
    expect(isPlugResolvable(devices, "AA:BB:CC:DD:EE:01")).toBe(false);
  });

  test("empty device list -> false, not a throw", () => {
    expect(isPlugResolvable([], "AA:BB:CC:DD:EE:01")).toBe(false);
  });
});

describe("checkPlugReadable — named test: could-not-look is neither pass nor fail", () => {
  test("a decodable reading (both P3 and P5 known) -> pass", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const result = await checkPlugReadable(plug);
    expect(result.outcome).toBe("pass");
  });

  test("power unknown -> could-not-look, never fail (the read completed, it just didn't decode)", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "unknown", reachable: true }) });
    const result = await checkPlugReadable(plug);
    expect(result.outcome).toBe("could-not-look");
    expect(result.outcome).not.toBe("fail");
    expect(result.outcome).not.toBe("pass");
  });

  test("reachable null -> could-not-look", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "off", reachable: null }) });
    const result = await checkPlugReadable(plug);
    expect(result.outcome).toBe("could-not-look");
  });

  test("a thrown transport/auth/API error -> fail, with the thrown message relayed verbatim, never reinterpreted", async () => {
    const plug = new FakeCyclePlugTransport({
      readHandler: async () => {
        throw new Error("Wyze API returned an error (code 2001).");
      },
    });
    const result = await checkPlugReadable(plug);
    expect(result.outcome).toBe("fail");
    expect(result.note).toBe("Wyze API returned an error (code 2001).");
  });
});

describe("checkPlugReadable — D5's structural pin, reused: this function's own parameter type has no writePower", () => {
  test("a write call inside a function typed to accept only PlugReader does not typecheck", () => {
    // The same compiler-enforced property `wyzr cycle --dry-run` already
    // relies on (src/cycle-plug.ts's own top comment) — PlugReader has no
    // writePower method AT ALL, so nothing inside a function whose
    // parameter is typed PlugReader can call one, regardless of what
    // concrete class is actually passed in at the call site. Mutation-tested:
    // temporarily typing `plug` below as `PlugWriter` instead of `PlugReader`
    // makes the next line's @ts-expect-error directive UNUSED, and
    // `bun run typecheck` then fails with "Unused '@ts-expect-error'
    // directive" — captured in the PR body — before this was reverted back
    // to PlugReader.
    function attemptWriteThroughReader(plug: PlugReader): void {
      // @ts-expect-error — PlugReader has no writePower method; only readState() is visible to the compiler here,
      // regardless of what concrete implementation (even a PlugWriter) is actually passed in at the call site.
      void plug.writePower("0");
    }
    void attemptWriteThroughReader;
  });
});
