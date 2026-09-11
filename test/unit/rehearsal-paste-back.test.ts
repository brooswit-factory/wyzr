// WYZR-30 review finding 2 (2026-09-11): `redactAddressesForPasteBack()`
// alone leaves a plug's mac/name surviving in every spelling except one
// (a colon-separated mac happens to look like IPv6). This suite pins
// EXACTLY the spellings the review measured as leaking, plus the
// sub-device-id suffix leak, so a regression in
// src/rehearsal-paste-back.ts reproduces the same finding, not a
// different one.

import { describe, expect, test } from "bun:test";
import {
  redactSafePlugIdentityForPasteBack,
  renderRehearsalForPasteBack,
  SAFE_PLUG_IDENTITY_REDACTED,
} from "../../src/rehearsal-paste-back.ts";
import type { RehearsalSafePlugIdentity } from "../../src/rehearsal-runner.ts";

describe("redactSafePlugIdentityForPasteBack — every mac spelling the review measured", () => {
  const NAME = "patio-heater";

  test("colon-separated mac (the one spelling that accidentally survived via the IPv6 pattern too)", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "AA:BB:CC:DD:EE:01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack("safePlug mac=AA:BB:CC:DD:EE:01", identity);
    expect(out).not.toContain("AA:BB:CC:DD:EE:01");
    expect(out).toContain(SAFE_PLUG_IDENTITY_REDACTED);
  });

  test("dash-separated mac — MEASURED to survive redactAddressesForPasteBack() alone", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "AA-BB-CC-DD-EE-01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack("safePlug mac=AA-BB-CC-DD-EE-01", identity);
    expect(out).not.toContain("AA-BB-CC-DD-EE-01");
  });

  test("bare (no-separator) mac — MEASURED to survive redactAddressesForPasteBack() alone", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "aabbccddee01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack("safePlug mac=aabbccddee01", identity);
    expect(out).not.toContain("aabbccddee01");
  });

  test("dotted-quad-shaped mac — MEASURED to survive redactAddressesForPasteBack() alone", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "aabb.ccdd.ee01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack("safePlug mac=aabb.ccdd.ee01", identity);
    expect(out).not.toContain("aabb.ccdd.ee01");
  });

  test("sub-device id built as <mac>-SUB1 — MEASURED to leave the -SUB1 suffix attached to an otherwise-redacted mac", () => {
    const identity: RehearsalSafePlugIdentity = {
      mac: "AA:BB:CC:DD:EE:01",
      model: "WLPPO",
      name: NAME,
      subDeviceId: "AA:BB:CC:DD:EE:01-SUB1",
    };
    const out = redactSafePlugIdentityForPasteBack("subDeviceId=AA:BB:CC:DD:EE:01-SUB1", identity);
    // The whole compound value is gone — not a redacted mac with a
    // leftover "-SUB1" tail still attached (the exact leak measured).
    expect(out).not.toContain("AA:BB:CC:DD:EE:01-SUB1");
    expect(out).not.toContain("-SUB1");
    expect(out).toBe(`subDeviceId=${SAFE_PLUG_IDENTITY_REDACTED}`);
  });

  test("the plug's configured NAME — MEASURED to survive redactAddressesForPasteBack() in every case", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "AA:BB:CC:DD:EE:01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack(`Configured safe plug: ${NAME} (mac=AA:BB:CC:DD:EE:01)`, identity);
    expect(out).not.toContain(NAME);
  });

  test("case-insensitive: a differently-cased mac still redacts", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "aa:bb:cc:dd:ee:01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack("mac=AA:BB:CC:DD:EE:01", identity);
    expect(out).not.toContain("AA:BB:CC:DD:EE:01");
  });

  test("null subDeviceId is simply skipped, never redacts the literal string 'null'", () => {
    const identity: RehearsalSafePlugIdentity = { mac: "AA:BB:CC:DD:EE:01", model: "WLPPO", name: NAME, subDeviceId: null };
    const out = redactSafePlugIdentityForPasteBack('{"subDeviceId":null}', identity);
    expect(out).toContain("null");
  });
});

describe("renderRehearsalForPasteBack — the ONE call site the procedure points at", () => {
  const identity: RehearsalSafePlugIdentity = {
    mac: "AA:BB:CC:DD:EE:01",
    model: "WLPPO",
    name: "patio-heater",
    subDeviceId: "AA:BB:CC:DD:EE:01-SUB1",
  };

  test("a realistic --json payload has every identifier AND every address scrubbed", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      command: "rehearse-safe-plug-write",
      outcome: "confirmed",
      safePlug: { mac: "AA:BB:CC:DD:EE:01", model: "WLPPO", name: "patio-heater", subDeviceId: "AA:BB:CC:DD:EE:01-SUB1" },
      reasons: ["a real IPv4 fixture 203.0.113.5 appearing incidentally in prose (control — proves address redaction still ran)"],
    });

    const out = renderRehearsalForPasteBack(raw, identity);

    expect(out).not.toContain("AA:BB:CC:DD:EE:01");
    expect(out).not.toContain("patio-heater");
    expect(out).not.toContain("SUB1");
    expect(out).not.toContain("203.0.113.5"); // control: address redaction still applies
  });

  test("assumption check: the un-redacted fixture actually contains all four things before scrubbing — so this test could genuinely fail", () => {
    const raw = JSON.stringify({
      safePlug: { mac: "AA:BB:CC:DD:EE:01", name: "patio-heater", subDeviceId: "AA:BB:CC:DD:EE:01-SUB1" },
      reasons: ["203.0.113.5"],
    });
    expect(raw).toContain("AA:BB:CC:DD:EE:01");
    expect(raw).toContain("patio-heater");
    expect(raw).toContain("SUB1");
    expect(raw).toContain("203.0.113.5");
  });

  test("ordinary paste-back content (an ISO-8601 timestamp, the outcome string) survives untouched", () => {
    const raw = JSON.stringify({ outcome: "confirmed", startedAt: "2026-09-11T15:26:26.144Z" });
    const out = renderRehearsalForPasteBack(raw, identity);
    expect(out).toContain("confirmed");
    expect(out).toContain("2026-09-11T15:26:26.144Z");
  });
});
