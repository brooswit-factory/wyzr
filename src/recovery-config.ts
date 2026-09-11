// The RecoveryConfig shape for `wyzr recovery status`.
//
// WYZR-20/WYZR-28: this module used to ALSO own `loadRecoveryConfigFromEnv()`,
// a provisional env-var-backed loader built on src/wedge-config.ts's shared
// pieces (Jira-activity, GitHub-activity, ssh, tunnel-ping, local-
// connectivity all came straight from `loadWedgeConfigFromEnv()`, since both
// `wyzr wedge status` and `wyzr recovery status` probe the same suspect box
// from the same manager-box vantage point) plus three genuinely new probes
// (uptime, daemon, fleet audit) that reused `ssh.host` as their own target
// rather than introducing a second host var. That loader has been REMOVED:
// `src/config.ts`'s `loadWyzrConfig()` is now the ONE configuration surface —
// see that module's own top comment for the ruling and for how each of the
// properties above survives in the new loader (the host-reuse coupling in
// particular: the suspect box's ssh/wrong-box-guard target is now a REQUIRED
// top-level value, so `uptime` is always configured in any config that loads
// at all — `daemon`/`fleet` still independently gate on their own
// required-together pairs, unchanged).
//
// Every field beyond `localConnectivity` still defaults to UNCONFIGURED
// unless the operator supplies its OWN section — same discipline as
// src/wedge-config.ts, now enforced by src/config.ts's refusal rules instead
// of by an env var simply being unset.

import type {
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "./wedge-probes.ts";
import type { DaemonProbeConfig, FleetAuditConfig, UptimeProbeConfig } from "./recovery-probes.ts";

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
