// Wires `wyzr recovery status` together: src/recovery-config.ts (config) +
// src/wedge-probes-real.ts (real probes, reused) + src/recovery-probes-real.ts
// (the three new real probes) + src/recovery-runner.ts (orchestration) +
// src/recovery.ts (the verdict engine) + src/output.ts. Same injectable-deps
// pattern as src/cli-wedge.ts — `RecoveryStatusDeps` lets
// test/unit/cli-recovery.test.ts exercise this module with FakeWedgeProbes/
// FakeRecoveryProbes and a hand-built RecoveryConfig, zero network, zero
// subprocess.
//
// READ-ONLY, STRUCTURALLY — not by convention. This file imports NOTHING
// from src/cli-plug.ts, src/plug.ts, src/auth-session.ts, or src/transport*
// — there is no import path from here to a write verb, and no import path
// to the Wyze plug/transport modules at all (this command does not read the
// plug — see README's "STRUCTURALLY EXCLUDED: PLUG LIVENESS"). Pinned by
// test/unit/recovery-imports.test.ts, which walks this module's transitive
// import closure and asserts none of those modules is reachable — watched
// RED first (a temporary import of src/plug.ts was added, observed to fail
// the test, then removed — see that test file's own top comment and the PR
// description for what was actually observed).

import { ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import { RealWedgeProbes } from "./wedge-probes-real.ts";
import type { WedgeProbes } from "./wedge-probes.ts";
import { RealRecoveryProbes } from "./recovery-probes-real.ts";
import type { RecoveryProbes } from "./recovery-probes.ts";
import type { RecoveryConfig } from "./recovery-config.ts";
import { loadWyzrConfig } from "./config.ts";
import { runRecoveryCheck } from "./recovery-runner.ts";
import {
  RecoveryVerdict,
  type CheckOutcome,
  type RecoveryChecks,
  type RecoveryDaemonObservation,
  type RecoveryDirectPathObservation,
  type RecoveryFleetObservation,
  type RecoveryInstrumentObservation,
  type RecoveryResult,
} from "./recovery.ts";
import type { LocalConnectivityObservation } from "./wedge.ts";

export const RECOVERY_SCHEMA_VERSION = 1;

export interface RecoveryStatusDeps {
  loadConfig: () => RecoveryConfig;
  createWedgeProbes: () => WedgeProbes;
  createRecoveryProbes: () => RecoveryProbes;
}

export const defaultRecoveryStatusDeps: RecoveryStatusDeps = {
  loadConfig: () => loadWyzrConfig().recovery,
  createWedgeProbes: () => new RealWedgeProbes(),
  createRecoveryProbes: () => new RealRecoveryProbes(),
};

/** Maps a verdict to its exit code — see src/errors.ts's
 * RecoveryNotRecovered/RecoveryFleetHalfRestored/RecoveryInconclusive/
 * RecoveryUnconfigured comments for why these are OUTCOME codes, not error
 * codes: the command succeeded at running every probe and is reporting
 * exactly what it observed. RECOVERED reuses ExitCode.Ok (0) — the ticket's
 * own DoD numbers only the four non-recovered classes as NEW codes. */
export function recoveryVerdictExitCode(verdict: RecoveryVerdict): number {
  switch (verdict) {
    case RecoveryVerdict.Recovered:
      return ExitCode.Ok;
    case RecoveryVerdict.NotRecovered:
      return ExitCode.RecoveryNotRecovered;
    case RecoveryVerdict.FleetHalfRestored:
      return ExitCode.RecoveryFleetHalfRestored;
    case RecoveryVerdict.Inconclusive:
      return ExitCode.RecoveryInconclusive;
    case RecoveryVerdict.Unconfigured:
      return ExitCode.RecoveryUnconfigured;
  }
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

export interface ReachabilityJson {
  name: string;
  outcome: RecoveryDirectPathObservation["outcome"];
  note: string | null;
}
export interface LocalControlJson {
  name: string;
  outcome: LocalConnectivityObservation["outcome"];
  confirms: readonly string[];
  note: string | null;
}
export interface UptimeJson {
  outcome: RecoveryResult["uptime"]["outcome"];
  uptimeMs: number | null;
  note: string | null;
}
export interface DaemonJson {
  outcome: RecoveryDaemonObservation["outcome"];
  unit: string | null;
  scope: RecoveryDaemonObservation["scope"];
  note: string | null;
}
export interface InstrumentJson {
  name: string;
  outcome: RecoveryInstrumentObservation["outcome"];
  lastSeenAt: string | null;
  note: string | null;
}
export interface FleetJson {
  outcome: RecoveryFleetObservation["outcome"];
  totalCandidates: number | null;
  flaggedCount: number | null;
  bareCount: number | null;
  note: string | null;
}

/** The full evidence trail, allowlist-projected — never a raw spread of
 * this module's internal RecoveryResult shapes, which carry a `__brand`
 * field on every observation that has no business in a published API (same
 * rule as src/cli-wedge.ts's own `--json` contract). */
export interface RecoveryStatusJson {
  schemaVersion: number;
  command: "recovery status";
  verdict: RecoveryVerdict;
  since: string;
  elapsedMs: number;
  checks: RecoveryChecks;
  reasons: readonly string[];
  reachability: ReachabilityJson[];
  localControl: LocalControlJson;
  uptime: UptimeJson;
  daemon: DaemonJson;
  instruments: InstrumentJson[];
  fleet: FleetJson;
}

export function toRecoveryStatusJson(result: RecoveryResult, sinceMs: number): RecoveryStatusJson {
  return {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    command: "recovery status",
    verdict: result.verdict,
    since: new Date(sinceMs).toISOString(),
    elapsedMs: result.elapsedMs,
    checks: result.checks,
    reasons: result.reasons,
    reachability: result.reachability.map((p) => ({ name: p.name, outcome: p.outcome, note: p.note })),
    localControl: {
      name: result.localControl.name,
      outcome: result.localControl.outcome,
      confirms: result.localControl.confirms,
      note: result.localControl.note,
    },
    uptime: { outcome: result.uptime.outcome, uptimeMs: result.uptime.uptimeMs, note: result.uptime.note },
    daemon: { outcome: result.daemon.outcome, unit: result.daemon.unit, scope: result.daemon.scope, note: result.daemon.note },
    instruments: result.instruments.map((i) => ({
      name: i.name,
      outcome: i.outcome,
      lastSeenAt: isoOrNull(i.lastSeenAt),
      note: i.note,
    })),
    fleet: {
      outcome: result.fleet.outcome,
      totalCandidates: result.fleet.totalCandidates,
      flaggedCount: result.fleet.flaggedCount,
      bareCount: result.fleet.bareCount,
      note: result.fleet.note,
    },
  };
}

function checkLine(label: string, outcome: CheckOutcome): string {
  const tag =
    outcome === "pass"
      ? "PASS"
      : outcome === "fail"
        ? "FAIL"
        : outcome === "could-not-look"
          ? "COULD-NOT-LOOK"
          : "NOT-CONFIGURED";
  return `  - ${label}: ${tag}`;
}

/**
 * Human-readable rendering, written for a competent person at 3am who
 * cannot ask a follow-up question — verdict first, then every check with
 * its own PASS/FAIL/COULD-NOT-LOOK/NOT-CONFIGURED state and what was
 * actually observed, then the reasons. For FLEET_HALF_RESTORED, states
 * plainly that wyzr does not fix this and why, so the reader does not sit
 * waiting for it to self-heal.
 */
export function formatRecoveryStatusHuman(result: RecoveryResult, sinceMs: number): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${result.verdict}`);
  lines.push(`Since (power-off instant): ${new Date(sinceMs).toISOString()}`);
  lines.push(`Elapsed since cut: ${result.elapsedMs}ms`);
  lines.push("");

  if (result.verdict === RecoveryVerdict.FleetHalfRestored) {
    lines.push(
      "The box itself is confirmed back and rebooted, but the fleet came back with bare (un-flagged) agent " +
        "processes present — this is the herdr-restore trap. wyzr DETECTS AND REPORTS this; it does NOT fix it. " +
        "Do not wait for it to self-heal — see README's 'wyzr recovery status' section for why, and WYZR-21 for " +
        "the fix.",
    );
    lines.push("");
  }

  lines.push("Checks:");
  lines.push(checkLine("reachability (ssh / tunnel-ping)", result.checks.reachability));
  lines.push(checkLine("reboot (uptime vs. elapsed-since-cut)", result.checks.reboot));
  lines.push(checkLine("daemon", result.checks.daemon));
  lines.push(checkLine("outside instruments (jira / github)", result.checks.instruments));
  lines.push(checkLine("fleet pane audit", result.checks.fleet));
  lines.push("");

  lines.push("Reachability:");
  for (const p of result.reachability) lines.push(`  - ${p.name}: ${p.outcome.toUpperCase()}${p.note ? ` — ${p.note}` : ""}`);
  lines.push("");

  const lc = result.localControl;
  lines.push(
    `Local-connectivity control (${lc.name}): ${lc.outcome.toUpperCase()}` +
      (lc.outcome === "healthy" ? ` — confirms: ${lc.confirms.join(", ") || "(none)"}` : lc.note ? ` — ${lc.note}` : ""),
  );
  lines.push("");

  lines.push(
    `Reboot: uptime=${result.uptime.uptimeMs === null ? "(unknown)" : `${result.uptime.uptimeMs}ms`} ` +
      `(outcome: ${result.uptime.outcome})${result.uptime.note ? ` — ${result.uptime.note}` : ""}`,
  );
  lines.push("");

  lines.push(
    `Daemon: unit="${result.daemon.unit ?? "(none)"}" scope="${result.daemon.scope ?? "(none)"}" — ` +
      `${result.daemon.outcome.toUpperCase()}${result.daemon.note ? ` — ${result.daemon.note}` : ""}`,
  );
  lines.push("");

  lines.push("Outside instruments:");
  for (const i of result.instruments) {
    const seen = i.lastSeenAt !== null ? new Date(i.lastSeenAt).toISOString() : "(never)";
    lines.push(`  - ${i.name}: ${i.outcome.toUpperCase()}, last seen ${seen}${i.note ? ` — ${i.note}` : ""}`);
  }
  lines.push("");

  lines.push(
    `Fleet pane audit: ${result.fleet.outcome.toUpperCase()} — total=${result.fleet.totalCandidates ?? "(n/a)"} ` +
      `flagged=${result.fleet.flaggedCount ?? "(n/a)"} bare=${result.fleet.bareCount ?? "(n/a)"}` +
      `${result.fleet.note ? ` — ${result.fleet.note}` : ""}`,
  );
  lines.push("");

  lines.push("Reasons:");
  for (const r of result.reasons) lines.push(`  - ${r}`);

  return lines.join("\n");
}

/**
 * The one function src/cli.ts calls. `sinceMs` must already be validated
 * (present, parseable, not future-dated) by the caller — see
 * src/cli.ts's `dispatchRecovery()`. Never throws for any of the four
 * non-RECOVERED verdicts — those are OUTCOME codes (src/errors.ts) — so
 * this prints the normal evidence-trail payload and RETURNS the code, same
 * discipline as src/cli-wedge.ts's runWedgeStatus().
 */
export async function runRecoveryStatus(deps: RecoveryStatusDeps, json: boolean, sinceMs: number, now?: number): Promise<number> {
  const config = deps.loadConfig();
  const wedgeProbes = deps.createWedgeProbes();
  const recoveryProbes = deps.createRecoveryProbes();
  const result = await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: sinceMs, now });

  if (json) {
    printJson(toRecoveryStatusJson(result, sinceMs));
  } else {
    printHuman(formatRecoveryStatusHuman(result, sinceMs));
  }
  return recoveryVerdictExitCode(result.verdict);
}
