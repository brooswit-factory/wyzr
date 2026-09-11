// The WedgeConfig shape plus the shared defaults/canonical-names every
// wedge-consuming module (this file, src/recovery-config.ts,
// src/cycle-config.ts, src/wedge-runner.ts, src/config.ts) builds from.
//
// WYZR-20/WYZR-28: this module used to ALSO own `loadWedgeConfigFromEnv()`,
// a provisional env-var-backed loader — this repo's own honest,
// provisional stand-in for "the values must be injectable" until the real
// config file shipped. It has been REMOVED: `src/config.ts`'s
// `loadWyzrConfig()` is now the ONE configuration surface the CLI reads —
// see that module's own top comment for the ruling ("one surface, not
// two") and why the env-var path had to go rather than stay as a second,
// silently-divergent source. What remains here — the `WedgeConfig` shape
// itself, the canonical instrument/direct-path names, and the documented
// defaults — is still shared: `src/config.ts` builds a `WedgeConfig` from
// the real file, and `src/wedge-runner.ts` still reports each slot's
// canonical name whether or not the operator configured it (the "an
// unconfigured instrument must report itself unconfigured" rule).
//
// This module ALSO used to export `positiveIntMs()`, a "coerce a numeric
// override or fall back to the default" helper whose fallback applied
// BOTH when a value was absent AND when it was present-but-malformed.
// Deliberately NOT carried forward: a follow-up review comment on this
// ticket sharpened exactly this point — "arguably defensible for an env
// var; in a config FILE it is a partial load that leaves an instrument
// quietly mis-tuned, which is the exact failure your ticket forbids."
// `src/config.ts`'s own numeric-field helper keeps the "absent -> documented
// default" half but REFUSES on "present but malformed" instead of silently
// substituting the default — see that module's own comment for the
// full reasoning. Keeping `positiveIntMs()` around with no caller left
// whose semantics it actually matches would only be untested dead code
// against this repo's coverage floor, so it is deleted rather than kept.

import type {
  ControlPlaneConfig,
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "./wedge-probes.ts";

export interface WedgeConfig {
  readonly jira: JiraInstrumentConfig | undefined;
  readonly github: GitHubInstrumentConfig | undefined;
  readonly ssh: DirectPathConfig | undefined;
  readonly tunnelPing: DirectPathConfig | undefined;
  readonly localConnectivity: LocalConnectivityConfig;
  readonly controlPlane: ControlPlaneConfig | undefined;
}

export const DEFAULT_QUIET_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — a starting point this project chose, not a measured value; see README.
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

/**
 * Cloudflare's public anycast DNS resolver. Chosen as the local-
 * connectivity control's default target because it has NO dependency on
 * this project's own fleet infrastructure (unlike the suspect box, its
 * tunnel, Jira, or GitHub) and is a well-known, high-uptime public service
 * — safe to name in a public repo, unlike a fleet hostname would be.
 * Reachability confirmed live from this project's own dev sandbox on
 * 2026-09-10 (a single ICMP echo, ~20ms round trip) — see README's "wyzr
 * wedge status" section for the full note; this is this project's own
 * choice (tier (d)), not a contract Cloudflare has made with this project.
 */
export const DEFAULT_LOCAL_CONNECTIVITY_TARGET = "1.1.1.1";

/** The dependency id every instrument that is reachable only via the
 * manager machine's own internet connection should declare — see
 * src/wedge.ts's top comment, point 2, for why Jira- and GitHub-activity
 * both declaring this (and this control confirming it) is what makes their
 * silence independent evidence rather than one shared blip. */
export const MANAGER_INTERNET_DEPENDENCY = "manager-internet";

/** Canonical names for each instrument/direct-path slot, shared between
 * src/config.ts's real loader and src/wedge-runner.ts's unconfigured
 * fallback — the SAME name must be used whether or not the operator has
 * configured the corresponding section, so `wyzr wedge status` shows a
 * stable "jira-activity: UNCONFIGURED" row rather than that row silently
 * disappearing (README's/ticket's "an unconfigured instrument must report
 * itself unconfigured" — reporting requires the slot to exist at all). */
export const JIRA_INSTRUMENT_NAME = "jira-activity";
export const GITHUB_INSTRUMENT_NAME = "github-activity";
export const SSH_DIRECT_PATH_NAME = "ssh";
export const TUNNEL_PING_DIRECT_PATH_NAME = "tunnel-ping";

export const DEFAULT_LOCAL_CONNECTIVITY_CONFIG: LocalConnectivityConfig = {
  name: "local-connectivity",
  target: DEFAULT_LOCAL_CONNECTIVITY_TARGET,
  timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  confirms: [MANAGER_INTERNET_DEPENDENCY],
};

