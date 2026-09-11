// Aggregates config for `wyzr recovery status`. Per the ticket ("reuse the
// existing wedge config's shared pieces rather than duplicating them"), this
// module does NOT re-declare env vars for anything WYZR-16 already owns:
// Jira-activity, GitHub-activity, ssh, tunnel-ping, and local-connectivity
// all come straight from src/wedge-config.ts's `loadWedgeConfigFromEnv()` —
// the SAME `WYZR_WEDGE_*` env vars configure both `wyzr wedge status` and
// `wyzr recovery status`, because both probe the same suspect box from the
// same manager-box vantage point. Only the three genuinely new probes (the
// reboot check's uptime read, the daemon check, the fleet-pane audit) get
// new env vars below.
//
// DESIGN DECISION THIS TICKET LEFT OPEN, RESOLVED HERE: the new probes do
// NOT get their own `--host` config. They reuse `ssh.host` (WYZR-16's own
// `WYZR_WEDGE_SSH_HOST`) as their target, because they read the SAME
// suspect box WYZR-16's ssh direct path already points at — introducing a
// second host var would let an operator misconfigure the two to point at
// different boxes with no error, and there is no legitimate reason for
// them to differ. Consequence: if `WYZR_WEDGE_SSH_HOST` is unset, the
// uptime/daemon/fleet probes are unconfigured too, regardless of their own
// env vars — see loadRecoveryConfigFromEnv() below.
//
// Every field defaults to UNCONFIGURED unless the operator supplies it —
// same discipline as src/wedge-config.ts, and for the same reason: this is
// the NORMAL state until WYZR-20 ships (a later, already-filed story owns
// the real config file/install).

import {
  loadWedgeConfigFromEnv,
  positiveIntMs,
  DEFAULT_PROBE_TIMEOUT_MS,
  type WedgeConfigEnv,
} from "./wedge-config.ts";
import type {
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "./wedge-probes.ts";
import type { DaemonProbeConfig, DaemonScope, FleetAuditConfig, UptimeProbeConfig } from "./recovery-probes.ts";

export interface RecoveryConfig {
  readonly jira: JiraInstrumentConfig | undefined;
  readonly github: GitHubInstrumentConfig | undefined;
  readonly ssh: DirectPathConfig | undefined;
  readonly tunnelPing: DirectPathConfig | undefined;
  readonly localConnectivity: LocalConnectivityConfig;
  readonly uptime: UptimeProbeConfig | undefined;
  readonly daemon: DaemonProbeConfig | undefined;
  readonly fleet: FleetAuditConfig | undefined;
}

/** The env vars this loader reads BEYOND what src/wedge-config.ts's
 * `WedgeConfigEnv` already covers (jira/github/ssh/tunnel-ping/local-
 * connectivity — reused verbatim, see this module's top comment). */
export interface RecoveryConfigEnv extends WedgeConfigEnv {
  /** No default — see src/recovery-probes.ts's `DaemonProbeConfig` comment
   * for why a wrong/missing scope must never silently resolve to a guess. */
  WYZR_RECOVERY_DAEMON_UNIT?: string | undefined;
  /** Must be exactly `"user"` or `"system"` — anything else (including
   * absent) leaves the daemon check unconfigured, never defaults to
   * either. */
  WYZR_RECOVERY_DAEMON_SCOPE?: string | undefined;
  WYZR_RECOVERY_DAEMON_TIMEOUT_MS?: string | undefined;

  /** No default — naming a process-identifying pattern in this public repo
   * would itself be a fleet-fact leak (see src/recovery-probes.ts's
   * `FleetAuditConfig` comment). */
  WYZR_RECOVERY_FLEET_PROCESS_MATCH?: string | undefined;
  /** Comma-separated list of substrings a "flagged" (non-bare) process's
   * argv must ALL contain. No default. */
  WYZR_RECOVERY_FLEET_EXPECTED_FLAGS?: string | undefined;
  WYZR_RECOVERY_FLEET_TIMEOUT_MS?: string | undefined;

  /** Overrides the uptime probe's own timeout — defaults to the reused
   * ssh config's own `timeoutMs` when absent, never a fresh, undocumented
   * default. */
  WYZR_RECOVERY_UPTIME_TIMEOUT_MS?: string | undefined;
}

const systemEnv: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>;

function parseDaemonScope(value: string | undefined): DaemonScope | undefined {
  return value === "user" || value === "system" ? value : undefined;
}

function parseExpectedFlags(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builds a RecoveryConfig from env vars. Every field beyond
 * `localConnectivity` defaults to unconfigured — see this module's top
 * comment.
 */
export function loadRecoveryConfigFromEnv(env: RecoveryConfigEnv = systemEnv): RecoveryConfig {
  const wedgeShared = loadWedgeConfigFromEnv(env);
  const ssh = wedgeShared.ssh;

  const scope = parseDaemonScope(env.WYZR_RECOVERY_DAEMON_SCOPE);
  const daemon: DaemonProbeConfig | undefined =
    ssh && env.WYZR_RECOVERY_DAEMON_UNIT && scope
      ? {
          host: ssh.host,
          unit: env.WYZR_RECOVERY_DAEMON_UNIT,
          scope,
          timeoutMs: positiveIntMs(env.WYZR_RECOVERY_DAEMON_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
        }
      : undefined;

  const expectedFlags = parseExpectedFlags(env.WYZR_RECOVERY_FLEET_EXPECTED_FLAGS);
  const fleet: FleetAuditConfig | undefined =
    ssh && env.WYZR_RECOVERY_FLEET_PROCESS_MATCH && expectedFlags.length > 0
      ? {
          host: ssh.host,
          processMatch: env.WYZR_RECOVERY_FLEET_PROCESS_MATCH,
          expectedFlags,
          timeoutMs: positiveIntMs(env.WYZR_RECOVERY_FLEET_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
        }
      : undefined;

  const uptime: UptimeProbeConfig | undefined = ssh
    ? {
        host: ssh.host,
        timeoutMs: positiveIntMs(env.WYZR_RECOVERY_UPTIME_TIMEOUT_MS, ssh.timeoutMs),
      }
    : undefined;

  return {
    jira: wedgeShared.jira,
    github: wedgeShared.github,
    ssh: wedgeShared.ssh,
    tunnelPing: wedgeShared.tunnelPing,
    localConnectivity: wedgeShared.localConnectivity,
    uptime,
    daemon,
    fleet,
  };
}
