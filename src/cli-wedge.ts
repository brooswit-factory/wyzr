// Wires `wyzr wedge status` together: src/wedge-config.ts (config) +
// src/wedge-probes-real.ts (real probes) + src/wedge-runner.ts
// (orchestration) + src/wedge.ts (the verdict engine) + src/output.ts.
// Same injectable-deps pattern as src/cli-devices.ts/src/cli-plug.ts —
// `WedgeStatusDeps` lets test/unit/cli-wedge.test.ts exercise this module
// with FakeWedgeProbes and a hand-built WedgeConfig, zero network, zero
// subprocess.
//
// READ-ONLY, STRUCTURALLY — not by convention. This file imports NOTHING
// from src/cli-plug.ts, src/plug.ts, src/auth-session.ts, or src/transport*
// — there is no import path from here to a write verb for the same reason
// a control-plane reading cannot become an instrument (src/wedge.ts's top
// comment, point 3): the property is enforced by what this module is
// allowed to import, not by a runtime check someone could remove.

import { ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import { RealWedgeProbes } from "./wedge-probes-real.ts";
import type { WedgeProbes } from "./wedge-probes.ts";
import { loadWedgeConfigFromEnv, type WedgeConfig } from "./wedge-config.ts";
import { runWedgeCheck } from "./wedge-runner.ts";
import {
  WedgeVerdict,
  type ControlPlaneReading,
  type DirectPathObservation,
  type InstrumentAssessment,
  type LocalConnectivityObservation,
  type WedgeResult,
} from "./wedge.ts";

export const WEDGE_SCHEMA_VERSION = 1;

export interface WedgeStatusDeps {
  loadConfig: () => WedgeConfig;
  createProbes: () => WedgeProbes;
}

export const defaultWedgeStatusDeps: WedgeStatusDeps = {
  loadConfig: () => loadWedgeConfigFromEnv(),
  createProbes: () => new RealWedgeProbes(),
};

/** Maps a verdict to its exit code — see src/errors.ts's ExitCode.WedgeNotProven/
 * WedgeInconclusiveBySharedCause comments for why these are OUTCOME codes,
 * not error codes, and why INCONCLUSIVE gets its own code distinct from
 * NOT_PROVEN: a script must be able to tell "not wedged" from "could not
 * look" without parsing `reasons`. */
export function wedgeVerdictExitCode(verdict: WedgeVerdict): number {
  switch (verdict) {
    case WedgeVerdict.Proven:
      return ExitCode.Ok;
    case WedgeVerdict.NotProven:
      return ExitCode.WedgeNotProven;
    case WedgeVerdict.InconclusiveBySharedCause:
      return ExitCode.WedgeInconclusiveBySharedCause;
  }
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

export interface InstrumentJson {
  name: string;
  dependsOn: readonly string[];
  outcome: InstrumentAssessment["outcome"];
  lastSeenAt: string | null;
  quietForMs: number | null;
  quietThresholdMs: number;
  silent: boolean;
  note: string | null;
}

export interface DirectPathJson {
  name: string;
  outcome: DirectPathObservation["outcome"];
  note: string | null;
}

export interface LocalControlJson {
  name: string;
  outcome: LocalConnectivityObservation["outcome"];
  confirms: readonly string[];
  note: string | null;
}

export interface ControlPlaneJson {
  name: string;
  online: boolean | "unknown";
  note: string | null;
}

/** The full evidence trail, allowlist-projected (same rule as
 * src/devices.ts/src/plug.ts's own `--json` contracts) — never a raw spread
 * of this module's internal WedgeResult shapes, which carry a `__brand`
 * field that has no business in a published API. */
export interface WedgeStatusJson {
  schemaVersion: number;
  command: "wedge status";
  verdict: WedgeVerdict;
  reasons: readonly string[];
  instruments: InstrumentJson[];
  directPaths: DirectPathJson[];
  localControl: LocalControlJson;
  controlPlane: ControlPlaneJson[];
}

function projectInstrument(i: InstrumentAssessment): InstrumentJson {
  return {
    name: i.name,
    dependsOn: i.dependsOn,
    outcome: i.outcome,
    lastSeenAt: isoOrNull(i.lastSeenAt),
    quietForMs: i.quietForMs,
    quietThresholdMs: i.quietThresholdMs,
    silent: i.isSilent,
    note: i.note,
  };
}

function projectDirectPath(p: DirectPathObservation): DirectPathJson {
  return { name: p.name, outcome: p.outcome, note: p.note };
}

function projectLocalControl(l: LocalConnectivityObservation): LocalControlJson {
  return { name: l.name, outcome: l.outcome, confirms: l.confirms, note: l.note };
}

function projectControlPlane(c: ControlPlaneReading): ControlPlaneJson {
  return { name: c.name, online: c.online, note: c.note };
}

export function toWedgeStatusJson(result: WedgeResult): WedgeStatusJson {
  return {
    schemaVersion: WEDGE_SCHEMA_VERSION,
    command: "wedge status",
    verdict: result.verdict,
    reasons: result.reasons,
    instruments: result.instruments.map(projectInstrument),
    directPaths: result.directPaths.map(projectDirectPath),
    localControl: projectLocalControl(result.localControl),
    controlPlane: result.controlPlane.map(projectControlPlane),
  };
}

function formatDuration(ms: number): string {
  if (ms < 0) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join("");
}

function formatInstrumentLine(i: InstrumentAssessment): string {
  const noteSuffix = i.note ? ` — ${i.note}` : "";
  if (i.outcome !== "observed") {
    return (
      `  - ${i.name}: ${i.outcome.toUpperCase()} (excluded from quorum) — ` +
      `${i.dependsOn.join(", ") || "no declared dependencies"}${noteSuffix}`
    );
  }
  const state = i.isSilent ? "SILENT" : "active";
  const seenAt = i.lastSeenAt !== null ? new Date(i.lastSeenAt).toISOString() : "(never)";
  return (
    `  - ${i.name}: ${state}, last seen ${seenAt}, quiet for ${formatDuration(i.quietForMs ?? 0)} ` +
    `(threshold ${formatDuration(i.quietThresholdMs)}) — depends on: ${i.dependsOn.join(", ") || "(none declared)"}${noteSuffix}`
  );
}

function formatDirectPathLine(p: DirectPathObservation): string {
  const note = p.note ? ` — ${p.note}` : "";
  return `  - ${p.name}: ${p.outcome.toUpperCase()}${note}`;
}

/**
 * Human-readable rendering of the full evidence trail — required so a
 * human reading this DURING the degrading window (README/ticket: the hour
 * before automation would ever act) can see how long each instrument has
 * been quiet, when it was last heard from, what the direct paths did, and
 * which verdict follows and why, not just a bare yes/no.
 */
export function formatWedgeStatusHuman(result: WedgeResult): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${result.verdict}`);
  lines.push("");
  lines.push("Instruments:");
  if (result.instruments.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const i of result.instruments) lines.push(formatInstrumentLine(i));
  }
  lines.push("");
  lines.push("Direct paths:");
  if (result.directPaths.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const p of result.directPaths) lines.push(formatDirectPathLine(p));
  }
  lines.push("");
  const lc = result.localControl;
  lines.push(
    `Local-connectivity control (${lc.name}): ${lc.outcome.toUpperCase()}` +
      (lc.outcome === "healthy" ? ` — confirms: ${lc.confirms.join(", ") || "(none)"}` : lc.note ? ` — ${lc.note}` : ""),
  );
  if (result.controlPlane.length > 0) {
    lines.push("");
    lines.push("Control-plane (informational only — cannot affect the verdict):");
    for (const cp of result.controlPlane) {
      lines.push(`  - ${cp.name}: ${cp.online}${cp.note ? ` — ${cp.note}` : ""}`);
    }
  }
  lines.push("");
  lines.push("Reasons:");
  for (const r of result.reasons) lines.push(`  - ${r}`);
  return lines.join("\n");
}

/**
 * The one function src/cli.ts calls. Never throws for a NOT_PROVEN or
 * INCONCLUSIVE_BY_SHARED_CAUSE verdict — those are OUTCOME codes (see
 * src/errors.ts), so this prints the normal evidence-trail payload and
 * RETURNS the code, the same discipline src/cli-plug.ts's runPlugWrite()
 * uses for 9/10.
 */
export async function runWedgeStatus(deps: WedgeStatusDeps, json: boolean, now?: number): Promise<number> {
  const config = deps.loadConfig();
  const probes = deps.createProbes();
  const result = await runWedgeCheck({ config, probes, now });

  if (json) {
    printJson(toWedgeStatusJson(result));
  } else {
    printHuman(formatWedgeStatusHuman(result));
  }
  return wedgeVerdictExitCode(result.verdict);
}
