// A first-class fake implementation of WedgeProbes (src/wedge-probes.ts),
// shipped alongside the real one (src/wedge-probes-real.ts), for exercising
// every code path with NO network and NO subprocess. Same shape as
// src/transport-fake.ts's FakeWyzeTransport: a handler override per method,
// each defaulting to a plain, clearly-labeled reading.
//
// Fixture provenance (per the ticket's tiering requirement — mirrors
// docs/wyze-api-findings-2026-09-02.md's (a)/(b)/(c)/(d) scale, applied per
// fixture rather than once for the whole file, since this module's fixtures
// are NOT uniformly synthetic the way transport-fake.ts's are):
// - `fakeGitHubActivityReading()`'s default epoch-ms/ISO shape is CAPTURED
//   — see src/wedge-probes-real.ts's own top comment for the live
//   2026-09-10 observation this reflects (an unauthenticated
//   `GET /repos/.../events` array, each entry's `created_at` an ISO 8601
//   string at the top level).
// - `fakeJiraActivityReading()`, `fakeControlPlaneReading()`, and every
//   direct-path fixture below are SYNTHETIC — constructed from this
//   project's own inference / public documentation, never a captured
//   response. See each function's own comment.

import type {
  RawControlPlaneReading,
  RawDirectPathReading,
  RawInstrumentReading,
  RawLocalControlReading,
  WedgeProbes,
  ControlPlaneConfig,
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "./wedge-probes.ts";

export type Handler<Config, Reading> = (config: Config) => Reading | Promise<Reading>;

export interface FakeWedgeProbesOptions {
  jiraHandler?: Handler<JiraInstrumentConfig, RawInstrumentReading>;
  gitHubHandler?: Handler<GitHubInstrumentConfig, RawInstrumentReading>;
  sshHandler?: Handler<DirectPathConfig, RawDirectPathReading>;
  tunnelPingHandler?: Handler<DirectPathConfig, RawDirectPathReading>;
  localConnectivityHandler?: Handler<LocalConnectivityConfig, RawLocalControlReading>;
  controlPlaneHandler?: Handler<ControlPlaneConfig, RawControlPlaneReading>;
}

/** CAPTURED (see this module's top comment) — a recently-active instrument. */
export function fakeInstrumentObserved(lastSeenAt: number): RawInstrumentReading {
  return { outcome: "observed", lastSeenAt, note: null };
}

/** SYNTHETIC. */
export function fakeJiraActivityReading(lastSeenAt: number): RawInstrumentReading {
  return fakeInstrumentObserved(lastSeenAt);
}

/** CAPTURED-shape (see this module's top comment): GitHub's events
 * endpoints really do carry a top-level `created_at` per entry. The
 * TIMESTAMP passed here is whatever a test needs, never a claim about a
 * real event. */
export function fakeGitHubActivityReading(lastSeenAt: number): RawInstrumentReading {
  return fakeInstrumentObserved(lastSeenAt);
}

/** SYNTHETIC. `"dead"`/`"alive"`/`"unconfirmed"` mirror
 * src/wedge-probes-real.ts's classifyDirectPath() outcomes. */
export function fakeDirectPathDead(note: string | null = "no response within the configured timeout"): RawDirectPathReading {
  return { outcome: "dead", note };
}
export function fakeDirectPathAlive(): RawDirectPathReading {
  return { outcome: "alive", note: null };
}
export function fakeDirectPathUnconfirmed(note: string | null = "fast, inconclusive failure"): RawDirectPathReading {
  return { outcome: "unconfirmed", note };
}

/** SYNTHETIC. */
export function fakeLocalControlHealthy(): RawLocalControlReading {
  return { outcome: "healthy", note: null };
}
export function fakeLocalControlUnhealthy(note: string | null = "no reply from the local-connectivity target"): RawLocalControlReading {
  return { outcome: "unhealthy", note };
}
export function fakeLocalControlError(note: string | null = "the local-connectivity probe itself failed"): RawLocalControlReading {
  return { outcome: "error", note };
}

/** SYNTHETIC — but the field this reflects (`Self.Online` as a JSON
 * boolean) was confirmed live from `tailscale status --json` against this
 * project's own dev sandbox, 2026-09-10 — see
 * src/wedge-probes-real.ts's top comment. Only the VALUE here is synthetic. */
export function fakeControlPlaneReading(online: boolean | "unknown" = true): RawControlPlaneReading {
  return { online, note: null };
}

export class FakeWedgeProbes implements WedgeProbes {
  constructor(private readonly opts: FakeWedgeProbesOptions = {}) {}

  async checkJiraActivity(config: JiraInstrumentConfig): Promise<RawInstrumentReading> {
    return this.opts.jiraHandler ? await this.opts.jiraHandler(config) : fakeJiraActivityReading(Date.now());
  }

  async checkGitHubActivity(config: GitHubInstrumentConfig): Promise<RawInstrumentReading> {
    return this.opts.gitHubHandler ? await this.opts.gitHubHandler(config) : fakeGitHubActivityReading(Date.now());
  }

  async checkSsh(config: DirectPathConfig): Promise<RawDirectPathReading> {
    return this.opts.sshHandler ? await this.opts.sshHandler(config) : fakeDirectPathAlive();
  }

  async checkTunnelPing(config: DirectPathConfig): Promise<RawDirectPathReading> {
    return this.opts.tunnelPingHandler ? await this.opts.tunnelPingHandler(config) : fakeDirectPathAlive();
  }

  async checkLocalConnectivity(config: LocalConnectivityConfig): Promise<RawLocalControlReading> {
    return this.opts.localConnectivityHandler ? await this.opts.localConnectivityHandler(config) : fakeLocalControlHealthy();
  }

  async checkControlPlane(config: ControlPlaneConfig): Promise<RawControlPlaneReading> {
    return this.opts.controlPlaneHandler ? await this.opts.controlPlaneHandler(config) : fakeControlPlaneReading();
  }
}
