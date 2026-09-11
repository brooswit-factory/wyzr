// Wires `wyzr doctor` together: src/doctor-runner.ts (gathers every
// observation) + src/doctor.ts (decides the verdict) + src/output.ts (the
// single output boundary). Same injectable-deps pattern as
// src/cli-wedge.ts/src/cli-recovery.ts/src/cli-cycle.ts — `DoctorRunnerDeps`
// (src/doctor-runner.ts) lets test/unit/cli-doctor.test.ts exercise this
// module with a fake transport/wedge-probes/identity-probe and a hand-built
// config, zero network, zero credentials.
//
// READ-ONLY, STRUCTURALLY — not by convention. See
// test/unit/doctor-imports.test.ts (no import path from this command's
// entry point to src/cli-plug.ts, src/cycle-runner.ts, or src/cli-cycle.ts)
// and test/unit/doctor-no-write.test.ts (no `setProperty(`/`writePower(`
// call site anywhere in this command's own new files). This command DOES
// import src/auth-session.ts, src/transport.ts/src/transport-http.ts, and
// src/cycle-plug.ts — unlike `wyzr recovery status`, it must actually READ a
// plug, so those modules are necessarily reachable; see
// src/doctor-plug.ts's own top comment for what makes this command
// STRUCTURALLY incapable of writing despite that.

import { ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import { runDoctorCheck, type DoctorRunnerDeps } from "./doctor-runner.ts";
import { DoctorVerdict, type DoctorChecks, type DoctorPlugCheck, type DoctorResult, type DoctorVerdict as DoctorVerdictType } from "./doctor.ts";
import type { CheckOutcome } from "./recovery.ts";
import type { WrongBoxGuardOutcome } from "./cycle-wrong-box.ts";

export const DOCTOR_SCHEMA_VERSION = 1;

/** Maps a verdict to its exit code — see src/errors.ts's
 * DoctorNotReady/DoctorInconclusive/DoctorUnconfigured comments for why
 * these are OUTCOME codes, not error codes: the command ran every check it
 * could and is reporting exactly what it observed. READY reuses
 * `ExitCode.Ok` (0), same convention as `RecoveryVerdict.Recovered`. */
export function doctorVerdictExitCode(verdict: DoctorVerdictType): number {
  switch (verdict) {
    case DoctorVerdict.Ready:
      return ExitCode.Ok;
    case DoctorVerdict.NotReady:
      return ExitCode.DoctorNotReady;
    case DoctorVerdict.Inconclusive:
      return ExitCode.DoctorInconclusive;
    case DoctorVerdict.Unconfigured:
      return ExitCode.DoctorUnconfigured;
  }
}

export interface DoctorPlugJson {
  label: "fleetPlug" | "safePlug";
  mac: string | null;
  model: string | null;
  name: string | null;
  resolvable: CheckOutcome;
  resolvableNote: string | null;
  readable: CheckOutcome;
  readableNote: string | null;
}

export interface DoctorInstrumentJson {
  name: string;
  outcome: CheckOutcome;
  note: string | null;
}

export interface DoctorWrongBoxJson {
  outcome: WrongBoxGuardOutcome;
  reasons: readonly string[];
}

/** The full evidence trail, allowlist-projected field by field — never a
 * raw spread of `DoctorResult`, same discipline as
 * src/cli-recovery.ts's `toRecoveryStatusJson()`. */
export interface DoctorStatusJson {
  schemaVersion: number;
  command: "doctor";
  verdict: DoctorVerdictType;
  reasons: readonly string[];
  config: { outcome: CheckOutcome; note: string | null; optionalSections: Readonly<Record<string, boolean>> };
  credentials: { outcome: CheckOutcome; note: string | null };
  cloud: { outcome: CheckOutcome; note: string | null };
  fleetPlug: DoctorPlugJson;
  safePlug: DoctorPlugJson;
  instruments: DoctorInstrumentJson[];
  wrongBoxGuard: DoctorWrongBoxJson;
  unproven: readonly string[];
  checks: DoctorChecks;
}

function plugJson(plug: DoctorPlugCheck): DoctorPlugJson {
  return {
    label: plug.label,
    mac: plug.mac,
    model: plug.model,
    name: plug.name,
    resolvable: plug.resolvable,
    resolvableNote: plug.resolvableNote,
    readable: plug.readable,
    readableNote: plug.readableNote,
  };
}

export function toDoctorJson(result: DoctorResult): DoctorStatusJson {
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    command: "doctor",
    verdict: result.verdict,
    reasons: result.reasons,
    config: { outcome: result.config.outcome, note: result.config.note, optionalSections: result.config.optionalSections },
    credentials: { outcome: result.credentials.outcome, note: result.credentials.note },
    cloud: { outcome: result.cloud.outcome, note: result.cloud.note },
    fleetPlug: plugJson(result.fleetPlug),
    safePlug: plugJson(result.safePlug),
    instruments: result.instruments.map((i) => ({ name: i.name, outcome: i.outcome, note: i.note })),
    wrongBoxGuard: { outcome: result.wrongBoxGuard.outcome, reasons: result.wrongBoxGuard.reasons },
    unproven: result.unproven,
    checks: result.checks,
  };
}

function tag(outcome: CheckOutcome): string {
  switch (outcome) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "could-not-look":
      return "COULD-NOT-LOOK";
    case "not-configured":
      return "NOT-CONFIGURED";
  }
}

function checkLine(label: string, outcome: CheckOutcome, note: string | null): string {
  return `  - ${label}: ${tag(outcome)}${note ? ` — ${note}` : ""}`;
}

function plugLines(plug: DoctorPlugCheck): string[] {
  const identity = plug.mac ? `${plug.name ?? "(unnamed)"} (mac=${plug.mac}, model=${plug.model})` : "(configured identity unknown)";
  return [
    `${plug.label} — ${identity}`,
    checkLine("resolvable (present in this account's own device list)", plug.resolvable, plug.resolvableNote),
    checkLine("readable (P3/P5 decode via a read-only session)", plug.readable, plug.readableNote),
  ];
}

/**
 * Human-readable rendering, written for a competent person at 3am who
 * cannot ask a follow-up question — verdict first, then every check with
 * its own PASS/FAIL/COULD-NOT-LOOK/NOT-CONFIGURED state and what was
 * actually observed, the wrong-box guard's own evidence trail verbatim,
 * what remains unproven, then the full reasons list.
 */
export function formatDoctorHuman(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${result.verdict}`);
  lines.push("");

  lines.push("Checks:");
  lines.push(checkLine("config", result.config.outcome, result.config.note));
  if (result.config.outcome === "pass") {
    for (const [section, present] of Object.entries(result.config.optionalSections)) {
      lines.push(`      optional section "${section}": ${present ? "configured" : "not configured"}`);
    }
  }
  lines.push(checkLine("credentials", result.credentials.outcome, result.credentials.note));
  lines.push(checkLine("cloud (login attempt)", result.cloud.outcome, result.cloud.note));
  lines.push(...plugLines(result.fleetPlug));
  lines.push(...plugLines(result.safePlug));
  for (const i of result.instruments) lines.push(checkLine(`instrument "${i.name}"`, i.outcome, i.note));
  lines.push(`  - wrong-box guard: ${result.wrongBoxGuard.outcome.toUpperCase()}`);
  for (const r of result.wrongBoxGuard.reasons) lines.push(`      ${r}`);
  lines.push("");

  lines.push("What remains unproven:");
  for (const u of result.unproven) lines.push(`  - ${u}`);
  lines.push("");

  lines.push("Reasons:");
  for (const r of result.reasons) lines.push(`  - ${r}`);

  return lines.join("\n");
}

/**
 * The one function src/cli.ts calls. Never throws for a diagnostic finding
 * — see src/doctor-runner.ts's own top comment; this always prints the
 * normal evidence-trail payload and RETURNS the code, the same discipline
 * as this repo's other read-only status commands.
 */
export async function runDoctorCommand(deps: DoctorRunnerDeps, json: boolean): Promise<number> {
  const result = await runDoctorCheck(deps);
  if (json) {
    printJson(toDoctorJson(result));
  } else {
    printHuman(formatDoctorHuman(result));
  }
  return doctorVerdictExitCode(result.verdict);
}
