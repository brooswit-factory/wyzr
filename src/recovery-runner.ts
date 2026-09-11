// Orchestrates a single `wyzr recovery status` run: reads a RecoveryConfig,
// calls every CONFIGURED probe concurrently (each under its own enforced
// timeout — real wall-clock lives HERE, never in src/recovery.ts, which
// does no I/O at all), assembles the result into the shapes
// src/recovery.ts's pure evaluateRecovery() expects, and returns its
// RecoveryResult unchanged. Same role, same shape, as src/wedge-runner.ts.
//
// THE PROBE COMPOSITION THE TICKET REQUIRES: this runner takes BOTH a
// `WedgeProbes` (src/wedge-probes.ts — reused verbatim for ssh, tunnel-ping,
// Jira-activity, GitHub-activity, and local-connectivity; NOT
// checkControlPlane, which this story has no use for) AND a `RecoveryProbes`
// (src/recovery-probes.ts — the three genuinely new probes: uptime, daemon,
// fleet-audit). Composition over widening `WedgeProbes` itself — see
// src/recovery-probes.ts's own top comment for why.

import { registerSecret } from "./redact.ts";
import { attempt, type Attempt } from "./wedge-runner.ts";
import type {
  RawDirectPathReading,
  RawInstrumentReading,
  RawLocalControlReading,
  WedgeProbes,
} from "./wedge-probes.ts";
import type { LocalConnectivityObservation } from "./wedge.ts";
import {
  evaluateRecovery,
  type RecoveryDaemonObservation,
  type RecoveryDirectPathObservation,
  type RecoveryFleetObservation,
  type RecoveryInstrumentObservation,
  type RecoveryResult,
  type RecoveryUptimeObservation,
} from "./recovery.ts";
import type {
  RawDaemonReading,
  RawFleetAuditReading,
  RawUptimeReading,
  RecoveryProbes,
} from "./recovery-probes.ts";
import type { RecoveryConfig } from "./recovery-config.ts";
import {
  GITHUB_INSTRUMENT_NAME,
  JIRA_INSTRUMENT_NAME,
  SSH_DIRECT_PATH_NAME,
  TUNNEL_PING_DIRECT_PATH_NAME,
} from "./wedge-config.ts";

type OrUnconfigured<T> = Attempt<T> | "unconfigured";

function toDirectPathObservation(name: string, result: OrUnconfigured<RawDirectPathReading>): RecoveryDirectPathObservation {
  const base = { __brand: "recovery-direct-path" as const, name };
  if (result === "unconfigured") {
    return { ...base, outcome: "not-configured", note: "not configured — no operator-supplied host for this direct path" };
  }
  if (result.kind === "timeout") {
    return { ...base, outcome: "unconfirmed", note: "the probe's own overall budget elapsed before it could classify the path" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "unconfirmed", note: result.message };
  }
  return { ...base, outcome: result.value.outcome, note: result.value.note };
}

function toLocalControlObservation(
  name: string,
  confirms: readonly string[],
  result: Attempt<RawLocalControlReading>,
): LocalConnectivityObservation {
  const base = { __brand: "wedge-local-control" as const, name, confirms };
  if (result.kind === "timeout") {
    return { ...base, outcome: "timeout", note: "the control did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", note: result.message };
  }
  return { ...base, outcome: result.value.outcome, note: result.value.note };
}

function toInstrumentObservation(name: string, result: OrUnconfigured<RawInstrumentReading>): RecoveryInstrumentObservation {
  const base = { __brand: "recovery-instrument" as const, name };
  if (result === "unconfigured") {
    return { ...base, outcome: "not-configured", lastSeenAt: null, note: "not configured — no operator-supplied target for this instrument" };
  }
  if (result.kind === "timeout") {
    return { ...base, outcome: "timeout", lastSeenAt: null, note: "probe did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", lastSeenAt: null, note: result.message };
  }
  return { ...base, outcome: result.value.outcome, lastSeenAt: result.value.lastSeenAt, note: result.value.note };
}

function toUptimeObservation(result: OrUnconfigured<RawUptimeReading>): RecoveryUptimeObservation {
  const base = { __brand: "recovery-uptime" as const };
  if (result === "unconfigured") {
    return { ...base, outcome: "not-configured", uptimeMs: null, note: "not configured — no ssh host to read uptime from" };
  }
  if (result.kind === "timeout") {
    return { ...base, outcome: "timeout", uptimeMs: null, note: "the uptime probe did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", uptimeMs: null, note: result.message };
  }
  return { ...base, outcome: result.value.outcome, uptimeMs: result.value.uptimeMs, note: result.value.note };
}

function toDaemonObservation(
  unit: string | null,
  scope: "user" | "system" | null,
  result: OrUnconfigured<RawDaemonReading>,
): RecoveryDaemonObservation {
  const base = { __brand: "recovery-daemon" as const, unit, scope };
  if (result === "unconfigured") {
    return { ...base, outcome: "not-configured", note: "not configured — no unit/scope supplied" };
  }
  if (result.kind === "timeout") {
    return { ...base, outcome: "timeout", note: "the daemon-check probe did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", note: result.message };
  }
  return { ...base, outcome: result.value.outcome, note: result.value.note };
}

function toFleetObservation(result: OrUnconfigured<RawFleetAuditReading>): RecoveryFleetObservation {
  const base = { __brand: "recovery-fleet" as const };
  if (result === "unconfigured") {
    return {
      ...base,
      outcome: "not-configured",
      totalCandidates: null,
      flaggedCount: null,
      bareCount: null,
      note: "not configured — no process-match/expected-flags supplied",
    };
  }
  if (result.kind === "timeout") {
    return {
      ...base,
      outcome: "timeout",
      totalCandidates: null,
      flaggedCount: null,
      bareCount: null,
      note: "the fleet-audit probe did not complete within its configured timeout",
    };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", totalCandidates: null, flaggedCount: null, bareCount: null, note: result.message };
  }
  return {
    ...base,
    outcome: result.value.outcome,
    totalCandidates: result.value.totalCandidates,
    flaggedCount: result.value.flaggedCount,
    bareCount: result.value.bareCount,
    note: result.value.note,
  };
}

export interface RunRecoveryCheckOptions {
  readonly config: RecoveryConfig;
  readonly wedgeProbes: WedgeProbes;
  readonly recoveryProbes: RecoveryProbes;
  /** Required — the power-off instant, epoch ms. Validated (present,
   * parseable, not future-dated) by src/cli-recovery.ts BEFORE this
   * function is ever called; this function trusts its caller the same way
   * src/wedge-runner.ts trusts a valid WedgeConfig. */
  readonly since: number;
  /** Epoch ms "now" — defaults to Date.now(). Captured ONCE, before any
   * probe starts (this function's very first statement), so
   * `elapsedMs = now - since` is measured CONSERVATIVELY — from before the
   * probes ran, never from after a reply arrived. A later instant would
   * inflate `elapsedMs`, biasing toward a false PASS on the reboot check
   * (src/recovery.ts's `uptimeMs < elapsedMs` comparison) — see that
   * module's own comment. */
  readonly now?: number;
}

/**
 * Gathers every configured probe's reading (concurrently, each under its
 * own configured timeout) and hands the assembled RecoveryInput to
 * src/recovery.ts's evaluateRecovery() — the one and only place a verdict
 * is decided. This function performs I/O; evaluateRecovery() itself never
 * does.
 */
export async function runRecoveryCheck(options: RunRecoveryCheckOptions): Promise<RecoveryResult> {
  const { config, wedgeProbes, recoveryProbes, since } = options;
  // Captured BEFORE any probe starts — see this function's own
  // RunRecoveryCheckOptions.now comment for why this matters.
  const now = options.now ?? Date.now();

  // Registered before any probe runs — same discipline as
  // src/wedge-runner.ts's runWedgeCheck() and src/credentials.ts's
  // loadCredentials().
  registerSecret(config.jira?.authHeader);
  registerSecret(config.github?.token);

  const { jira, github, ssh, tunnelPing, daemon: daemonConfig, fleet: fleetConfig, uptime: uptimeConfig } = config;

  const [sshAttempt, tunnelAttempt, jiraAttempt, githubAttempt, localAttempt, uptimeAttempt, daemonAttempt, fleetAttempt] =
    await Promise.all([
      ssh ? attempt(() => wedgeProbes.checkSsh(ssh), ssh.timeoutMs) : Promise.resolve("unconfigured" as const),
      tunnelPing
        ? attempt(() => wedgeProbes.checkTunnelPing(tunnelPing), tunnelPing.timeoutMs)
        : Promise.resolve("unconfigured" as const),
      jira ? attempt(() => wedgeProbes.checkJiraActivity(jira), jira.timeoutMs) : Promise.resolve("unconfigured" as const),
      github ? attempt(() => wedgeProbes.checkGitHubActivity(github), github.timeoutMs) : Promise.resolve("unconfigured" as const),
      attempt(() => wedgeProbes.checkLocalConnectivity(config.localConnectivity), config.localConnectivity.timeoutMs),
      uptimeConfig
        ? attempt(() => recoveryProbes.checkUptime(uptimeConfig), uptimeConfig.timeoutMs)
        : Promise.resolve("unconfigured" as const),
      daemonConfig
        ? attempt(() => recoveryProbes.checkDaemon(daemonConfig), daemonConfig.timeoutMs)
        : Promise.resolve("unconfigured" as const),
      fleetConfig
        ? attempt(() => recoveryProbes.checkFleetAudit(fleetConfig), fleetConfig.timeoutMs)
        : Promise.resolve("unconfigured" as const),
    ]);

  // Every slot is ALWAYS represented in the evidence trail — configured or
  // not — same reasoning as src/wedge-runner.ts's own comment: an
  // unconfigured check must never silently vanish from the output.
  const reachability: RecoveryDirectPathObservation[] = [
    ssh ? toDirectPathObservation(ssh.name, sshAttempt) : toDirectPathObservation(SSH_DIRECT_PATH_NAME, "unconfigured"),
    tunnelPing
      ? toDirectPathObservation(tunnelPing.name, tunnelAttempt)
      : toDirectPathObservation(TUNNEL_PING_DIRECT_PATH_NAME, "unconfigured"),
  ];

  const localControl = toLocalControlObservation(config.localConnectivity.name, config.localConnectivity.confirms, localAttempt);

  const instruments: RecoveryInstrumentObservation[] = [
    jira ? toInstrumentObservation(jira.name, jiraAttempt) : toInstrumentObservation(JIRA_INSTRUMENT_NAME, "unconfigured"),
    github ? toInstrumentObservation(github.name, githubAttempt) : toInstrumentObservation(GITHUB_INSTRUMENT_NAME, "unconfigured"),
  ];

  const uptime = toUptimeObservation(uptimeAttempt);
  const daemon = toDaemonObservation(daemonConfig?.unit ?? null, daemonConfig?.scope ?? null, daemonAttempt);
  const fleet = toFleetObservation(fleetAttempt);

  return evaluateRecovery({ now, since, reachability, localControl, uptime, daemon, instruments, fleet });
}
