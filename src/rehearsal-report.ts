// `wyzr rehearse-safe-plug-write`'s `--json` contract and human rendering.
// Same allowlist-projection discipline as src/cycle-report.ts's own
// CycleJson (never a raw spread of RehearsalResult) and, for the OFF/
// restore sections specifically, REUSES src/cycle-report.ts's own exported
// `projectOff()`/`projectRestore()`/`offSection()`/`restoreSection()`
// verbatim — those functions are generic over OffAttemptEvidence/
// RestoreEvidence (src/cycle.ts), with nothing cycle-specific in their own
// bodies, so there is no reason for a second, parallel rendering of the
// identical shape.

import { ExitCode } from "./errors.ts";
import { offSection, projectOff, projectRestore, restoreSection, type CycleOffJson, type CycleRestoreJson } from "./cycle-report.ts";
import type { PowerState, Reachable } from "./plug.ts";
import type { RehearsalOutcome, RehearsalResult, RehearsalSafePlugIdentity } from "./rehearsal-runner.ts";

export const REHEARSAL_SCHEMA_VERSION = 1;

/** Maps every RehearsalOutcome to its exit code — switches on the VALUE,
 * same discipline as src/cycle-report.ts's own cycleOutcomeExitCode().
 * `confirmed` reuses `ExitCode.Ok` (0), same symmetry `CycleOutcome`'s own
 * `"recovered"` uses. */
export function rehearsalOutcomeExitCode(outcome: RehearsalOutcome): number {
  switch (outcome) {
    case "refused_same_as_fleet_plug":
      return ExitCode.RehearsalRefusedSameAsFleetPlug;
    case "refused_by_precondition":
      return ExitCode.RehearsalRefusedByPrecondition;
    case "would_write":
      return ExitCode.RehearsalPreviewWouldWrite;
    case "stranded":
      return ExitCode.RehearsalStranded;
    case "confirmed":
      return ExitCode.Ok;
  }
}

export interface RehearsalPreconditionsJson {
  outcome: string | null;
  power: PowerState | null;
  reachable: Reachable | null;
  note: string | null;
}

export interface RehearsalJson {
  schemaVersion: number;
  command: "rehearse-safe-plug-write";
  outcome: RehearsalOutcome;
  dryRun: boolean;
  reasons: readonly string[];
  safePlug: RehearsalSafePlugIdentity;
  preconditions: RehearsalPreconditionsJson;
  off: CycleOffJson | null;
  restore: CycleRestoreJson | null;
}

export function toRehearsalJson(result: RehearsalResult): RehearsalJson {
  return {
    schemaVersion: REHEARSAL_SCHEMA_VERSION,
    command: "rehearse-safe-plug-write",
    outcome: result.outcome,
    dryRun: result.dryRun,
    reasons: result.reasons,
    safePlug: result.safePlugIdentity,
    preconditions: {
      outcome: result.preconditions.outcome,
      power: result.preconditions.reading?.power ?? null,
      reachable: result.preconditions.reading?.reachable ?? null,
      note: result.preconditions.reading?.note ?? null,
    },
    off: result.off ? projectOff(result.off) : null,
    restore: result.restore ? projectRestore(result.restore) : null,
  };
}

/**
 * Human-readable rendering — same "written for a competent person at 3am
 * who cannot ask a follow-up" bar as src/cycle-report.ts's own
 * formatCycleHuman(). `stranded` gets the loudest treatment, same reason.
 */
export function formatRehearsalHuman(result: RehearsalResult): string {
  const lines: string[] = [];
  lines.push(`Outcome: ${result.outcome}${result.dryRun ? " (DRY RUN / PREVIEW — no write was possible on this path)" : ""}`);
  lines.push(`Configured safe plug: ${result.safePlugIdentity.name} (mac=${result.safePlugIdentity.mac}, model=${result.safePlugIdentity.model})`);
  lines.push("");

  if (result.outcome === "stranded") {
    lines.push("*** STRANDED — POWER IS OFF ON THE SAFE PLUG AND THE RESTORE WAS NOT CONFIRMED ***");
    lines.push("*** Go to the safe plug now and restore power by hand — see the full reasons below. ***");
    lines.push("");
  }

  lines.push("=== Preconditions ===");
  lines.push(
    `Outcome: ${result.preconditions.outcome ?? "(not attempted — refused before any read)"}` +
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

  lines.push("Full evidence trail:");
  for (const r of result.reasons) lines.push(`  - ${r}`);

  return lines.join("\n");
}
