// Aggregates the per-probe configs from src/wedge-probes.ts into one
// WedgeConfig, plus the provisional env-var-backed way of obtaining one at
// runtime. This module owns NO default for anything that would name a
// fleet host, tunnel, or credential — those are unconfigured unless an
// operator supplies them (see each field's own comment below and README's
// "wyzr wedge status" section). A LATER STORY owns the real config file and
// install (WYZR-16's own scope note); this env-var loader is this task's
// own honest, provisional answer to "the values must be injectable" — do
// not read its existence as that later story's design being settled.

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
 * this env loader and src/wedge-runner.ts's unconfigured fallback — the
 * SAME name must be used whether or not the operator has configured the
 * corresponding env vars, so `wyzr wedge status` shows a stable
 * "jira-activity: UNCONFIGURED" row rather than that row silently
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

/** The env vars this loader reads. Narrower than `NodeJS.ProcessEnv`, same
 * reasoning as src/credentials.ts's `CredentialsEnv` — a test can pass a
 * plain object instead of mutating the real `process.env`. */
export interface WedgeConfigEnv {
  WYZR_WEDGE_JIRA_BASE_URL?: string | undefined;
  WYZR_WEDGE_JIRA_PROJECT_KEY?: string | undefined;
  WYZR_WEDGE_JIRA_AUTH_HEADER?: string | undefined;
  WYZR_WEDGE_JIRA_QUIET_THRESHOLD_MS?: string | undefined;
  WYZR_WEDGE_JIRA_TIMEOUT_MS?: string | undefined;

  WYZR_WEDGE_GITHUB_OWNER?: string | undefined;
  WYZR_WEDGE_GITHUB_REPO?: string | undefined;
  WYZR_WEDGE_GITHUB_TOKEN?: string | undefined;
  WYZR_WEDGE_GITHUB_QUIET_THRESHOLD_MS?: string | undefined;
  WYZR_WEDGE_GITHUB_TIMEOUT_MS?: string | undefined;

  WYZR_WEDGE_SSH_HOST?: string | undefined;
  WYZR_WEDGE_SSH_TIMEOUT_MS?: string | undefined;
  WYZR_WEDGE_SSH_CONNECT_TIMEOUT_MS?: string | undefined;

  WYZR_WEDGE_TUNNEL_PING_HOST?: string | undefined;
  WYZR_WEDGE_TUNNEL_PING_TIMEOUT_MS?: string | undefined;
  WYZR_WEDGE_TUNNEL_PING_CONNECT_TIMEOUT_MS?: string | undefined;

  /** Overrides DEFAULT_LOCAL_CONNECTIVITY_TARGET — the one field above
   * that already has a safe default, so this is the one override that is
   * genuinely optional rather than "supply this or stay unconfigured." */
  WYZR_WEDGE_LOCAL_CONNECTIVITY_TARGET?: string | undefined;
  WYZR_WEDGE_LOCAL_CONNECTIVITY_TIMEOUT_MS?: string | undefined;

  /** Presence alone opts the control-plane reading in — its own value is
   * never used for anything but a label, since what to actually query
   * (e.g. a tailscale device name) is this repo's `tailscale status`
   * invocation, not a per-operator setting this task defines. */
  WYZR_WEDGE_CONTROL_PLANE_NAME?: string | undefined;
  WYZR_WEDGE_CONTROL_PLANE_TIMEOUT_MS?: string | undefined;
}

const systemEnv: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>;

// Exported (WYZR-25) so src/recovery-config.ts can reuse this parsing rule
// rather than duplicating it — this module is "internal, free to change"
// per README's published-interface section, so widening its export surface
// for another module in this repo to reuse is safe.
export function positiveIntMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Builds a WedgeConfig from env vars, defaulting every fleet-specific field
 * to `undefined` (unconfigured) rather than guessing — see this module's
 * top comment. Only `localConnectivity` is ever populated without explicit
 * operator input, because it alone has a default that names nothing about
 * this project's own fleet.
 */
export function loadWedgeConfigFromEnv(env: WedgeConfigEnv = systemEnv): WedgeConfig {
  const jira: JiraInstrumentConfig | undefined =
    env.WYZR_WEDGE_JIRA_BASE_URL && env.WYZR_WEDGE_JIRA_AUTH_HEADER
      ? {
          name: JIRA_INSTRUMENT_NAME,
          baseUrl: env.WYZR_WEDGE_JIRA_BASE_URL,
          projectKey: env.WYZR_WEDGE_JIRA_PROJECT_KEY,
          authHeader: env.WYZR_WEDGE_JIRA_AUTH_HEADER,
          dependsOn: [MANAGER_INTERNET_DEPENDENCY],
          quietThresholdMs: positiveIntMs(env.WYZR_WEDGE_JIRA_QUIET_THRESHOLD_MS, DEFAULT_QUIET_THRESHOLD_MS),
          timeoutMs: positiveIntMs(env.WYZR_WEDGE_JIRA_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
        }
      : undefined;

  const github: GitHubInstrumentConfig | undefined = env.WYZR_WEDGE_GITHUB_OWNER
    ? {
        name: GITHUB_INSTRUMENT_NAME,
        owner: env.WYZR_WEDGE_GITHUB_OWNER,
        repo: env.WYZR_WEDGE_GITHUB_REPO,
        token: env.WYZR_WEDGE_GITHUB_TOKEN,
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: positiveIntMs(env.WYZR_WEDGE_GITHUB_QUIET_THRESHOLD_MS, DEFAULT_QUIET_THRESHOLD_MS),
        timeoutMs: positiveIntMs(env.WYZR_WEDGE_GITHUB_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
      }
    : undefined;

  const ssh: DirectPathConfig | undefined = env.WYZR_WEDGE_SSH_HOST
    ? {
        name: SSH_DIRECT_PATH_NAME,
        host: env.WYZR_WEDGE_SSH_HOST,
        timeoutMs: positiveIntMs(env.WYZR_WEDGE_SSH_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
        connectTimeoutMs: positiveIntMs(env.WYZR_WEDGE_SSH_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
      }
    : undefined;

  const tunnelPing: DirectPathConfig | undefined = env.WYZR_WEDGE_TUNNEL_PING_HOST
    ? {
        name: TUNNEL_PING_DIRECT_PATH_NAME,
        host: env.WYZR_WEDGE_TUNNEL_PING_HOST,
        timeoutMs: positiveIntMs(env.WYZR_WEDGE_TUNNEL_PING_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
        connectTimeoutMs: positiveIntMs(env.WYZR_WEDGE_TUNNEL_PING_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
      }
    : undefined;

  const localConnectivity: LocalConnectivityConfig = {
    ...DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
    target: env.WYZR_WEDGE_LOCAL_CONNECTIVITY_TARGET || DEFAULT_LOCAL_CONNECTIVITY_CONFIG.target,
    timeoutMs: positiveIntMs(env.WYZR_WEDGE_LOCAL_CONNECTIVITY_TIMEOUT_MS, DEFAULT_LOCAL_CONNECTIVITY_CONFIG.timeoutMs),
  };

  const controlPlane: ControlPlaneConfig | undefined = env.WYZR_WEDGE_CONTROL_PLANE_NAME
    ? {
        name: env.WYZR_WEDGE_CONTROL_PLANE_NAME,
        timeoutMs: positiveIntMs(env.WYZR_WEDGE_CONTROL_PLANE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
      }
    : undefined;

  return { jira, github, ssh, tunnelPing, localConnectivity, controlPlane };
}
