// The single injectable boundary all of `wyzr wedge status`'s actual
// probing goes through — src/wedge-probes-real.ts (real HTTP/exec) and
// src/wedge-probes-fake.ts (canned readings) both implement this interface,
// and src/wedge-runner.ts is written against the interface only, never
// against either implementation directly. Same split as src/transport.ts
// vs src/transport-http.ts/src/transport-fake.ts vs src/auth-session.ts —
// see that trio's own comments for the pattern this module follows.
//
// Every method returns a RAW reading — no independence/quorum/verdict logic
// lives here. src/wedge.ts (the pure engine) never sees a WedgeProbes; it
// only sees the InstrumentObservation/DirectPathObservation/etc. shapes
// src/wedge-runner.ts assembles from a raw reading plus the matching config
// (`name`, `dependsOn`, `quietThresholdMs` — all config concerns, not
// something a single probe call decides for itself).
//
// PUBLISHED INTERFACE (WYZR-16's "what later stories inherit from your
// shape" — WYZR-18, post-cycle recovery verification, reuses THIS boundary
// and THESE direct-path probes rather than writing its own): the
// `WedgeProbes` interface, every config type below, and `RawDirectPathReading`/
// `RawDirectPathOutcome` in particular — `"alive"` is a first-class outcome
// here specifically so a second consumer can ask "is it alive?" and not
// only "is it dead?" through the same `checkSsh()`/`checkTunnelPing()`
// methods this task uses to ask the opposite question. This module has no
// dependency on src/wedge.ts (the verdict engine) or src/cli-wedge.ts — a
// future consumer can import this boundary and src/wedge-probes-real.ts's
// implementation without pulling in either.

export type RawProbeOutcome = "observed" | "error" | "timeout";

/** What a single instrument probe (Jira, GitHub, ...) returns. */
export interface RawInstrumentReading {
  readonly outcome: RawProbeOutcome;
  /** Epoch ms of the most recently observed activity. Present (non-null)
   * only when `outcome === "observed"`. */
  readonly lastSeenAt: number | null;
  /** Fragment-safe — see src/wedge.ts's InstrumentObservation.note. */
  readonly note: string | null;
}

export type RawDirectPathOutcome = "dead" | "alive" | "unconfirmed";

/** What ssh / tunnel-ping return. */
export interface RawDirectPathReading {
  readonly outcome: RawDirectPathOutcome;
  readonly note: string | null;
}

export type RawLocalControlOutcome = "healthy" | "unhealthy" | "error" | "timeout";

/** What the local-connectivity control (the shared-cause exclusion)
 * returns. `confirms` names which dependency ids this reading, if healthy,
 * rules out as a shared cause — see WedgeConfig.localConnectivity below for
 * where that list is declared. */
export interface RawLocalControlReading {
  readonly outcome: RawLocalControlOutcome;
  readonly note: string | null;
}

/** What the control-plane (tailscale-style) reading returns. Recorded only
 * — see src/wedge.ts's ControlPlaneReading for why it cannot affect a
 * verdict. */
export interface RawControlPlaneReading {
  readonly online: boolean | "unknown";
  readonly note: string | null;
}

/** Jira's most-recent-activity instrument. No defensible default exists for
 * `baseUrl`/`authHeader` — see README's "wyzr wedge status" section — so
 * this config is only ever present when the operator has actually supplied
 * it; absent, the runner reports the instrument itself as unconfigured
 * (src/wedge-runner.ts), never silently substituting a guess. */
export interface JiraInstrumentConfig {
  readonly name: string;
  /** e.g. `https://your-org.atlassian.net` — no trailing slash. */
  readonly baseUrl: string;
  /** Restrict the "most recent update" query to one project. Omitted means
   * "most recently updated issue visible to this credential, in any
   * project it can see." */
  readonly projectKey?: string;
  /** A complete `Authorization` header value (e.g. `Basic <base64>`) — a
   * CREDENTIAL. Registered with src/redact.ts by src/wedge-runner.ts before
   * this config is ever used, never printed by this probe on any path. */
  readonly authHeader: string;
  readonly dependsOn: readonly string[];
  readonly quietThresholdMs: number;
  readonly timeoutMs: number;
}

/** GitHub's most-recent-event instrument. No defensible default exists for
 * `owner` — see README — so this config is only present when supplied. */
export interface GitHubInstrumentConfig {
  readonly name: string;
  /** Org or user login whose public events are read (`/orgs/<owner>/events`
   * when `repo` is omitted, `/repos/<owner>/<repo>/events` otherwise). */
  readonly owner: string;
  readonly repo?: string;
  /** Optional — GitHub's events endpoints work unauthenticated for public
   * targets, at a lower rate limit (60/hour, confirmed live — see README).
   * A CREDENTIAL when present; registered for redaction the same as
   * `JiraInstrumentConfig.authHeader`. */
  readonly token?: string;
  readonly dependsOn: readonly string[];
  readonly quietThresholdMs: number;
  readonly timeoutMs: number;
}

/** ssh / tunnel-ping. No defensible default exists for `host` (which box,
 * which tunnel) — see README — so each is only present when supplied. */
export interface DirectPathConfig {
  readonly name: string;
  readonly host: string;
  /** Overall budget for the probe, enforced by src/wedge-runner.ts. */
  readonly timeoutMs: number;
  /** The underlying tool's own connect-timeout — see
   * src/wedge-probes-real.ts's classifyDirectPath() for why this, not
   * `timeoutMs`, is what "dead" is actually measured against. */
  readonly connectTimeoutMs: number;
}

/** The shared-cause exclusion. UNLIKE the instruments and direct paths
 * above, this DOES have a defensible default (see
 * DEFAULT_LOCAL_CONNECTIVITY_CONFIG in src/wedge-config.ts): a well-known,
 * high-uptime public target with no dependency on this project's own fleet
 * infrastructure is a safe thing to name in a public repo, unlike a fleet
 * hostname or tunnel name would be. */
export interface LocalConnectivityConfig {
  readonly name: string;
  readonly target: string;
  readonly timeoutMs: number;
  /** Dependency ids a healthy reading of `target` rules out as a shared
   * cause — see RawLocalControlReading.confirms. */
  readonly confirms: readonly string[];
}

/** tailscale-style control-plane liveness. Optional — recorded only when
 * configured, never defaults to a fleet-specific value. */
export interface ControlPlaneConfig {
  readonly name: string;
  readonly timeoutMs: number;
}

/**
 * Every probe wyzr can run. Each method is handed the SAME config object
 * src/wedge-runner.ts already has (rather than reaching for ambient env
 * vars itself) so a fake implementation never needs real config to be
 * exercised, and a real implementation never has a second, hidden source of
 * truth for what to probe.
 */
export interface WedgeProbes {
  checkJiraActivity(config: JiraInstrumentConfig): Promise<RawInstrumentReading>;
  checkGitHubActivity(config: GitHubInstrumentConfig): Promise<RawInstrumentReading>;
  checkSsh(config: DirectPathConfig): Promise<RawDirectPathReading>;
  checkTunnelPing(config: DirectPathConfig): Promise<RawDirectPathReading>;
  checkLocalConnectivity(config: LocalConnectivityConfig): Promise<RawLocalControlReading>;
  checkControlPlane(config: ControlPlaneConfig): Promise<RawControlPlaneReading>;
}
