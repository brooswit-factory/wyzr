// `wyzr rehearse-safe-plug-write`'s `--json`/human rendering
// (src/rehearsal-report.ts) — pure rendering, zero I/O, exercised against
// hand-built RehearsalResult fixtures (this module's own inputs are a
// published shape, not something that needs a real config or plug).

import { describe, expect, test } from "bun:test";
import { ExitCode } from "../../src/errors.ts";
import { formatRehearsalHuman, rehearsalOutcomeExitCode, REHEARSAL_SCHEMA_VERSION, toRehearsalJson } from "../../src/rehearsal-report.ts";
import type { RehearsalResult } from "../../src/rehearsal-runner.ts";

const SAFE_IDENTITY = { mac: "11:22:33:44:55:02", model: "WLPPO", name: "fixture-safe-plug" };

function baseResult(overrides: Partial<RehearsalResult> = {}): RehearsalResult {
  return {
    outcome: "would_write",
    dryRun: true,
    reasons: ["preview: preconditions cleared"],
    preconditions: { outcome: "cleared", reading: { power: "on", reachable: true, note: null } },
    off: null,
    restore: null,
    offInstant: null,
    safePlugIdentity: SAFE_IDENTITY,
    ...overrides,
  };
}

describe("rehearsalOutcomeExitCode", () => {
  test("maps every outcome to its own distinct exit code", () => {
    expect(rehearsalOutcomeExitCode("refused_same_as_fleet_plug")).toBe(ExitCode.RehearsalRefusedSameAsFleetPlug);
    expect(rehearsalOutcomeExitCode("refused_by_precondition")).toBe(ExitCode.RehearsalRefusedByPrecondition);
    expect(rehearsalOutcomeExitCode("would_write")).toBe(ExitCode.RehearsalPreviewWouldWrite);
    expect(rehearsalOutcomeExitCode("stranded")).toBe(ExitCode.RehearsalStranded);
    expect(rehearsalOutcomeExitCode("confirmed")).toBe(ExitCode.Ok);
  });
});

describe("toRehearsalJson", () => {
  test("allowlist-projects the result — schema version, command name, safe plug identity, preconditions", () => {
    const json = toRehearsalJson(baseResult());
    expect(json.schemaVersion).toBe(REHEARSAL_SCHEMA_VERSION);
    expect(json.command).toBe("rehearse-safe-plug-write");
    expect(json.safePlug).toEqual(SAFE_IDENTITY);
    expect(json.preconditions.outcome).toBe("cleared");
    expect(json.preconditions.power).toBe("on");
  });

  test("preconditions outcome/power/reachable/note are all null when refused before any read (guard 2)", () => {
    const json = toRehearsalJson(
      baseResult({ outcome: "refused_same_as_fleet_plug", dryRun: false, preconditions: { outcome: null, reading: null } }),
    );
    expect(json.preconditions.outcome).toBeNull();
    expect(json.preconditions.power).toBeNull();
    expect(json.preconditions.reachable).toBeNull();
    expect(json.preconditions.note).toBeNull();
  });

  test("off/restore project through src/cycle-report.ts's REUSED projectOff()/projectRestore() — never null once attempted", () => {
    const json = toRehearsalJson(
      baseResult({
        outcome: "confirmed",
        dryRun: false,
        off: { writeThrew: false, writeErrorMessage: null, readBacks: [], finalResult: "confirmed" },
        restore: { attempts: [], confirmed: true, elapsedMs: 10 },
        offInstant: 12345,
      }),
    );
    expect(json.off).not.toBeNull();
    expect(json.off!.finalResult).toBe("confirmed");
    expect(json.restore).not.toBeNull();
    expect(json.restore!.confirmed).toBe(true);
  });
});

describe("formatRehearsalHuman", () => {
  test("names the configured safe plug and the outcome", () => {
    const text = formatRehearsalHuman(baseResult());
    expect(text).toContain("fixture-safe-plug");
    expect(text).toContain("would_write");
  });

  test("STRANDED gets the loudest treatment — its own labeled block", () => {
    const text = formatRehearsalHuman(
      baseResult({
        outcome: "stranded",
        dryRun: false,
        reasons: ["STRANDED: power is OFF on the configured safe plug (fixture-safe-plug, mac=11:22:33:44:55:02)."],
        off: { writeThrew: false, writeErrorMessage: null, readBacks: [], finalResult: "unconfirmed" },
        restore: { attempts: [], confirmed: false, elapsedMs: 60 },
        offInstant: 999,
      }),
    );
    expect(text).toContain("STRANDED");
    expect(text.toUpperCase()).toContain("POWER IS OFF");
  });

  test("a refusal before any read renders 'not attempted' for preconditions, never a fabricated reading", () => {
    const text = formatRehearsalHuman(
      baseResult({ outcome: "refused_same_as_fleet_plug", dryRun: false, preconditions: { outcome: null, reading: null } }),
    );
    expect(text).toContain("not attempted");
  });
});
