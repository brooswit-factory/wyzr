// `wyzr cycle`'s `--json` contract and human rendering — same allowlist-
// projection discipline as src/cli-wedge.ts/src/cli-recovery.ts's own
// `--json` contracts (never a raw spread of an internal result shape, which
// carries `__brand` fields and, for `preconditions`, would otherwise expose
// this module's own witness machinery). The gate and recovery sections are
// rendered by REUSING src/cli-wedge.ts's `toWedgeStatusJson()`/
// `formatWedgeStatusHuman()` and src/cli-recovery.ts's
// `toRecoveryStatusJson()`/`formatRecoveryStatusHuman()` verbatim — composed,
// not reimplemented, same rule the ticket applies to the engines themselves.

import { ExitCode } from "./errors.ts";
import { toWedgeStatusJson, formatWedgeStatusHuman, type WedgeStatusJson } from "./cli-wedge.ts";
import { toRecoveryStatusJson, formatRecoveryStatusHuman, type RecoveryStatusJson } from "./cli-recovery.ts";
import type { PowerState, Reachable, WriteResult } from "./plug.ts";
import type { WrongBoxGuardOutcome } from "./cycle-wrong-box.ts";
import type { PreconditionsOutcome } from "./cycle-preconditions.ts";
import type {
  CycleOutcome,
  CycleResult,
  OffAttemptEvidence,
  ReadBackAttemptEvidence,
  RestoreAttemptEvidence,
  RestoreEvidence,
} from "./cycle.ts";

export const CYCLE_SCHEMA_VERSION = 1;

/** Maps every CycleOutcome to its exit code — switches on the VALUE, same
 * discipline as src/cli-wedge.ts's wedgeVerdictExitCode()/src/cli-recovery.ts's
 * recoveryVerdictExitCode(). `"would_act"` only ever appears on a dry run
 * (src/cycle-runner.ts's runCycleLive() never produces it), so this needs
 * no separate `dryRun` input to be correct. */
export function cycleOutcomeExitCode(outcome: CycleOutcome): number {
  switch (outcome) {
    case "refused_by_wrong_box_guard":
      return ExitCode.CycleRefusedByWrongBoxGuard;
    case "refused_by_precondition":
      return ExitCode.CycleRefusedByPrecondition;
    case "refused_by_gate":
      return ExitCode.CycleRefusedByGate;
    case "would_act":
      return ExitCode.CycleDryRunWouldAct;
    case "stranded":
      return ExitCode.CycleStranded;
    case "recovered":
      return ExitCode.Ok;
    case "not_recovered":
      return ExitCode.CycleNotRecovered;
    case "fleet_half_restored":
      return ExitCode.CycleFleetHalfRestored;
    case "recovery_inconclusive":
      return ExitCode.CycleRecoveryInconclusive;
    case "recovery_unconfigured":
      return ExitCode.CycleRecoveryUnconfigured;
  }
}

export interface CycleWrongBoxGuardJson {
  outcome: WrongBoxGuardOutcome;
  reasons: readonly string[];
}

export interface CyclePreconditionsJson {
  outcome: PreconditionsOutcome;
  power: PowerState | null;
  reachable: Reachable | null;
  note: string | null;
}

export interface CycleReadBackJson {
  attempt: number;
  atMs: number;
  result: WriteResult;
  power: PowerState;
  reachable: Reachable;
  note: string | null;
}

export interface CycleOffJson {
  writeThrew: boolean;
  writeErrorMessage: string | null;
  readBacks: CycleReadBackJson[];
  finalResult: WriteResult | "never_read";
}

export interface CycleRestoreAttemptJson extends CycleOffJson {
  attempt: number;
  atMs: number;
}

export interface CycleRestoreJson {
  attempts: CycleRestoreAttemptJson[];
  confirmed: boolean;
  elapsedMs: number;
}

export interface CycleJson {
  schemaVersion: number;
  command: "cycle";
  outcome: CycleOutcome;
  dryRun: boolean;
  forced: boolean;
  reasons: readonly string[];
  gate: WedgeStatusJson;
  wrongBoxGuard: CycleWrongBoxGuardJson;
  preconditions: CyclePreconditionsJson;
  off: CycleOffJson | null;
  restore: CycleRestoreJson | null;
  recovery: RecoveryStatusJson | null;
  handRestoreCommand: string | null;
}

function projectReadBack(r: ReadBackAttemptEvidence): CycleReadBackJson {
  return {
    attempt: r.attempt,
    atMs: r.atMs,
    result: r.result,
    power: r.reading.power,
    reachable: r.reading.reachable,
    note: r.reading.note,
  };
}

function projectOff(off: OffAttemptEvidence): CycleOffJson {
  return {
    writeThrew: off.writeThrew,
    writeErrorMessage: off.writeErrorMessage,
    readBacks: off.readBacks.map(projectReadBack),
    finalResult: off.finalResult,
  };
}

function projectRestoreAttempt(a: RestoreAttemptEvidence): CycleRestoreAttemptJson {
  return {
    attempt: a.attempt,
    atMs: a.atMs,
    writeThrew: a.writeThrew,
    writeErrorMessage: a.writeErrorMessage,
    readBacks: a.readBacks.map(projectReadBack),
    finalResult: a.finalResult,
  };
}

function projectRestore(restore: RestoreEvidence): CycleRestoreJson {
  return {
    attempts: restore.attempts.map(projectRestoreAttempt),
    confirmed: restore.confirmed,
    elapsedMs: restore.elapsedMs,
  };
}

export function toCycleJson(result: CycleResult): CycleJson {
  return {
    schemaVersion: CYCLE_SCHEMA_VERSION,
    command: "cycle",
    outcome: result.outcome,
    dryRun: result.dryRun,
    forced: result.forced,
    reasons: result.reasons,
    gate: toWedgeStatusJson(result.gate),
    wrongBoxGuard: { outcome: result.wrongBoxGuard.outcome, reasons: result.wrongBoxGuard.reasons },
    preconditions: {
      outcome: result.preconditions.outcome,
      power: result.preconditions.reading?.power ?? null,
      reachable: result.preconditions.reading?.reachable ?? null,
      note: result.preconditions.reading?.note ?? null,
    },
    off: result.off ? projectOff(result.off) : null,
    restore: result.restore ? projectRestore(result.restore) : null,
    recovery: result.recovery && result.offInstant !== null ? toRecoveryStatusJson(result.recovery, result.offInstant) : null,
    handRestoreCommand: result.handRestoreCommand,
  };
}

function readBackLine(r: ReadBackAttemptEvidence): string {
  return `      #${r.attempt} @${r.atMs}ms: ${r.result} (power=${r.reading.power}, reachable=${String(r.reading.reachable)})${r.reading.note ? ` — ${r.reading.note}` : ""}`;
}

function offSection(off: OffAttemptEvidence): string[] {
  const lines = [
    "OFF:",
    `  write ${off.writeThrew ? `threw: ${off.writeErrorMessage}` : "was issued (exactly once)"}`,
    `  read-back (${off.readBacks.length} attempt(s)), final: ${off.finalResult}`,
  ];
  for (const r of off.readBacks) lines.push(readBackLine(r));
  return lines;
}

function restoreSection(restore: RestoreEvidence): string[] {
  const lines = [
    "RESTORE (never-give-up):",
    `  ${restore.attempts.length} ON write attempt(s) over ${restore.elapsedMs}ms — ${restore.confirmed ? "CONFIRMED" : "NEVER CONFIRMED"}`,
  ];
  for (const a of restore.attempts) {
    lines.push(`  attempt #${a.attempt} @${a.atMs}ms: write ${a.writeThrew ? `threw: ${a.writeErrorMessage}` : "issued"}, final=${a.finalResult}`);
    for (const r of a.readBacks) lines.push(readBackLine(r));
  }
  return lines;
}

/**
 * Human-readable rendering — written, like src/cli-recovery.ts's own
 * formatRecoveryStatusHuman(), for a competent person at 3am who cannot
 * ask a follow-up. STRANDED gets the loudest treatment: its own labeled
 * block with the hand-restore command repeated verbatim (D1).
 */
export function formatCycleHuman(result: CycleResult): string {
  const lines: string[] = [];
  lines.push(`Outcome: ${result.outcome}${result.dryRun ? " (DRY RUN — no write was possible on this path)" : ""}${result.forced ? " (HUMAN-FORCED)" : ""}`);
  lines.push("");

  if (result.outcome === "stranded") {
    lines.push("*** STRANDED — POWER IS OFF AND THE RESTORE WAS NOT CONFIRMED ***");
    lines.push(`*** Restore it by hand: ${result.handRestoreCommand} ***`);
    lines.push("");
  }

  lines.push("=== Gate (src/wedge.ts, composed) ===");
  lines.push(formatWedgeStatusHuman(result.gate));
  lines.push("");

  lines.push("=== Wrong-box guard ===");
  lines.push(`Outcome: ${result.wrongBoxGuard.outcome}`);
  for (const r of result.wrongBoxGuard.reasons) lines.push(`  - ${r}`);
  lines.push("");

  lines.push("=== Preconditions ===");
  lines.push(
    `Outcome: ${result.preconditions.outcome}` +
      (result.preconditions.reading
        ? ` (power=${result.preconditions.reading.power}, reachable=${String(result.preconditions.reading.reachable)})`
        : ""),
  );
  lines.push("");

  if (result.off) {
    lines.push(...offSection(result.off));
    lines.push("");
  }
  if (result.restore) {
    lines.push(...restoreSection(result.restore));
    lines.push("");
  }

  if (result.recovery && result.offInstant !== null) {
    lines.push("=== Recovery verdict (src/recovery.ts, composed) ===");
    lines.push(formatRecoveryStatusHuman(result.recovery, result.offInstant));
    lines.push("");
  }

  lines.push("Full evidence trail:");
  for (const r of result.reasons) lines.push(`  - ${r}`);

  return lines.join("\n");
}
