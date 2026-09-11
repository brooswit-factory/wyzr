import { describe, expect, test } from "bun:test";
import { cycleOutcomeExitCode, formatCycleHuman, toCycleJson } from "../../src/cycle-report.ts";
import { ExitCode } from "../../src/errors.ts";
import { WedgeVerdict, type WedgeResult } from "../../src/wedge.ts";
import { evaluateRecovery, type RecoveryInput, type RecoveryResult } from "../../src/recovery.ts";
import type { CycleOutcome, CycleResult, OffAttemptEvidence, RestoreEvidence } from "../../src/cycle.ts";

function baseGate(): WedgeResult {
  return {
    verdict: WedgeVerdict.Proven,
    reasons: ["fixture reason"],
    instruments: [],
    directPaths: [],
    localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
    controlPlane: [],
    independentPairFound: null,
    independencePairs: [],
  };
}

function baseResult(overrides: Partial<CycleResult> = {}): CycleResult {
  return {
    outcome: "refused_by_gate",
    dryRun: false,
    forced: false,
    reasons: ["fixture: gate refused"],
    gate: baseGate(),
    wrongBoxGuard: { outcome: "not_target", reasons: ["fixture: not the target"] },
    preconditions: { outcome: "cleared", reading: { power: "on", reachable: true, note: null } },
    off: null,
    restore: null,
    recovery: null,
    offInstant: null,
    handRestoreCommand: null,
    ...overrides,
  };
}

describe("cycleOutcomeExitCode — switches on the outcome VALUE, exhaustively", () => {
  const table: Array<[CycleOutcome, number]> = [
    ["refused_by_wrong_box_guard", ExitCode.CycleRefusedByWrongBoxGuard],
    ["refused_by_precondition", ExitCode.CycleRefusedByPrecondition],
    ["refused_by_gate", ExitCode.CycleRefusedByGate],
    ["would_act", ExitCode.CycleDryRunWouldAct],
    ["stranded", ExitCode.CycleStranded],
    ["recovered", ExitCode.Ok],
    ["not_recovered", ExitCode.CycleNotRecovered],
    ["fleet_half_restored", ExitCode.CycleFleetHalfRestored],
    ["recovery_inconclusive", ExitCode.CycleRecoveryInconclusive],
    ["recovery_unconfigured", ExitCode.CycleRecoveryUnconfigured],
  ];

  for (const [outcome, expected] of table) {
    test(`${outcome} -> ${expected}`, () => {
      expect(cycleOutcomeExitCode(outcome)).toBe(expected);
    });
  }

  test("every code produced is distinct", () => {
    const codes = table.map(([outcome]) => cycleOutcomeExitCode(outcome));
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("toCycleJson — allowlist projection, never a raw internal spread", () => {
  test("does not leak any __brand field from the composed gate/recovery results", () => {
    const json = toCycleJson(baseResult());
    expect(JSON.stringify(json)).not.toContain("__brand");
  });

  test("preconditions projects power/reachable/note from the reading, or nulls when there was none", () => {
    const withReading = toCycleJson(baseResult());
    expect(withReading.preconditions.power).toBe("on");
    expect(withReading.preconditions.reachable).toBe(true);

    const withoutReading = toCycleJson(
      baseResult({ preconditions: { outcome: "cloud_unreachable", reading: null } }),
    );
    expect(withoutReading.preconditions.power).toBeNull();
    expect(withoutReading.preconditions.reachable).toBeNull();
  });

  test("recovery is null unless BOTH a recovery result and an offInstant are present", () => {
    const json = toCycleJson(baseResult());
    expect(json.recovery).toBeNull();
  });

  test("schemaVersion and command are stable, machine-checkable fields", () => {
    const json = toCycleJson(baseResult());
    expect(json.schemaVersion).toBe(1);
    expect(json.command).toBe("cycle");
  });
});

const SINCE = 1_800_000_000_000;
const RECOVERY_NOW = SINCE + 100_000;

function fullRecoveryResult(): RecoveryResult {
  const input: RecoveryInput = {
    now: RECOVERY_NOW,
    since: SINCE,
    reachability: [
      { __brand: "recovery-direct-path", name: "ssh", outcome: "alive", note: null },
      { __brand: "recovery-direct-path", name: "tunnel-ping", outcome: "alive", note: null },
    ],
    localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: ["manager-internet"], note: null },
    uptime: { __brand: "recovery-uptime", outcome: "observed", uptimeMs: 50_000, note: null },
    daemon: { __brand: "recovery-daemon", outcome: "healthy", unit: "test.service", scope: "user", note: null },
    instruments: [
      { __brand: "recovery-instrument", name: "jira-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
      { __brand: "recovery-instrument", name: "github-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
    ],
    fleet: { __brand: "recovery-fleet", outcome: "enumerated", totalCandidates: 2, flaggedCount: 2, bareCount: 0, note: null },
  };
  return evaluateRecovery(input);
}

function fullOff(): OffAttemptEvidence {
  return {
    writeThrew: false,
    writeErrorMessage: null,
    readBacks: [
      { attempt: 1, atMs: 0, result: "contradicted", reading: { power: "on", reachable: true, note: null } },
      { attempt: 2, atMs: 10, result: "confirmed", reading: { power: "off", reachable: true, note: "settled" } },
    ],
    finalResult: "confirmed",
  };
}

function fullRestore(): RestoreEvidence {
  return {
    attempts: [
      {
        attempt: 1,
        atMs: 20,
        writeThrew: true,
        writeErrorMessage: "simulated-fixture-write-error",
        readBacks: [{ attempt: 1, atMs: 25, result: "unconfirmed", reading: { power: "unknown", reachable: null, note: null } }],
        finalResult: "unconfirmed",
      },
      {
        attempt: 2,
        atMs: 30,
        writeThrew: false,
        writeErrorMessage: null,
        readBacks: [{ attempt: 1, atMs: 35, result: "confirmed", reading: { power: "on", reachable: true, note: null } }],
        finalResult: "confirmed",
      },
    ],
    confirmed: true,
    elapsedMs: 35,
  };
}

describe("toCycleJson / formatCycleHuman — a fully populated result (off, restore, and recovery all present)", () => {
  test("toCycleJson projects every readBack/attempt in off, restore, and the composed recovery verdict, with no __brand leakage", () => {
    const result = baseResult({
      outcome: "recovered",
      off: fullOff(),
      restore: fullRestore(),
      recovery: fullRecoveryResult(),
      offInstant: SINCE,
    });
    const json = toCycleJson(result);

    expect(json.off?.readBacks).toHaveLength(2);
    expect(json.off?.readBacks[0]?.result).toBe("contradicted");
    expect(json.off?.readBacks[0]?.power).toBe("on");
    expect(json.restore?.attempts).toHaveLength(2);
    expect(json.restore?.attempts[0]?.writeThrew).toBe(true);
    expect(json.restore?.attempts[0]?.writeErrorMessage).toBe("simulated-fixture-write-error");
    expect(json.restore?.attempts[1]?.readBacks[0]?.result).toBe("confirmed");
    expect(json.recovery?.verdict).toBe("RECOVERED");
    expect(JSON.stringify(json)).not.toContain("__brand");
  });

  test("formatCycleHuman renders the OFF section, the RESTORE section (including a threw attempt), and the composed recovery verdict block", () => {
    const result = baseResult({
      outcome: "recovered",
      off: fullOff(),
      restore: fullRestore(),
      recovery: fullRecoveryResult(),
      offInstant: SINCE,
    });
    const text = formatCycleHuman(result);

    expect(text).toContain("OFF:");
    expect(text).toContain("read-back (2 attempt(s)), final: confirmed");
    expect(text).toContain("RESTORE (never-give-up):");
    expect(text).toContain("threw: simulated-fixture-write-error");
    expect(text).toContain("=== Recovery verdict (src/recovery.ts, composed) ===");
    expect(text).toContain("RECOVERED");
  });
});

describe("formatCycleHuman — STRANDED gets the loudest treatment (D1)", () => {
  test("a stranded result's human rendering leads with the loud block and repeats the hand-restore command verbatim", () => {
    const text = formatCycleHuman(
      baseResult({
        outcome: "stranded",
        reasons: ["fixture: STRANDED — restore not confirmed. Restore it by hand: fixture-restore-cmd --now"],
        handRestoreCommand: "fixture-restore-cmd --now",
        off: {
          writeThrew: false,
          writeErrorMessage: null,
          readBacks: [{ attempt: 1, atMs: 0, result: "confirmed", reading: { power: "off", reachable: true, note: null } }],
          finalResult: "confirmed",
        },
        restore: { attempts: [], confirmed: false, elapsedMs: 1000 },
        offInstant: 0,
      }),
    );

    expect(text).toContain("STRANDED");
    expect(text).toContain("fixture-restore-cmd --now");
    expect(text.indexOf("STRANDED")).toBeLessThan(text.indexOf("Full evidence trail"));
  });

  test("a non-stranded result never prints the loud STRANDED banner", () => {
    const text = formatCycleHuman(baseResult({ outcome: "recovered" }));
    expect(text).not.toContain("STRANDED — POWER IS OFF");
  });
});
