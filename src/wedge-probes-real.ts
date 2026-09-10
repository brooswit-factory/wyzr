// The real implementation of WedgeProbes (src/wedge-probes.ts): performs
// actual HTTP calls (Jira, GitHub) and shells out (ssh, ping, tailscale).
// Every I/O-performing primitive is INJECTABLE (`fetchImpl` defaulting to
// the global `fetch`, `runTimed`/`runCapturing` defaulting to a Bun.spawn-
// based implementation) so request construction, response parsing, and
// exit-code/timing classification can all be unit-tested with NO network
// and NO subprocess — see test/unit/wedge-probes-real.test.ts, which never
// lets any default apply. Same shape as src/transport-http.ts's
// `fetchImpl` injection.
//
// Every probe method below CATCHES its own failures and returns a
// classified RawXReading rather than throwing — src/wedge-runner.ts's own
// attempt() wrapper is a defensive backstop for a genuinely unexpected
// throw, not this module's primary error path.
//
// Fixture/claim provenance, per the ticket's tiering requirement (mirrors
// docs/wyze-api-findings-2026-09-02.md's (a)/(b)/(c)/(d) scale):
// - GitHub events shape (`created_at` at the top level of each array
//   entry): CAPTURED LIVE from this project's own dev sandbox, 2026-09-10,
//   via an unauthenticated `GET /repos/brooswit-factory/wyzr/events` —
//   tier (a)/(b) equivalent, not a guess. See README's "wyzr wedge status"
//   section for the exact response shape observed.
// - `tailscale status --json`'s `Self.Online` boolean field: CAPTURED LIVE
//   from this project's own dev sandbox, 2026-09-10, by running the
//   `tailscale` binary already present there. Field NAME only — no host,
//   IP, or other sandbox-identifying value from that output is reproduced
//   anywhere in this repo, per the ticket's "never a fleet hostname" rule.
// - Jira's `/rest/api/3/search` response shape (`issues[0].fields.updated`
//   as an ISO 8601 string): tier (b) — read from Atlassian's own public
//   REST API documentation. NEVER captured live in this project: doing so
//   would require a real credentialed call against a real Jira instance,
//   which this task does not have authorization or occasion to make. See
//   README's "This has never been exercised against reality" note.
// - ssh/ping behavior against an unresolvable hostname (near-instant
//   failure, well under any reasonable connect timeout) and against a
//   well-known public host (a normal, fast reply): CAPTURED LIVE from this
//   project's own dev sandbox, 2026-09-10 — see classifyDirectPath()'s own
//   comment for what that observation informs about this module's design.

import type {
  ControlPlaneConfig,
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
  RawControlPlaneReading,
  RawDirectPathReading,
  RawInstrumentReading,
  RawLocalControlReading,
  WedgeProbes,
} from "./wedge-probes.ts";

export type FetchLike = typeof fetch;

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  /** `true` only when THIS function's own timeoutMs elapsed and it had to
   * kill the process — never inferred from elapsed time alone, so a
   * process that happens to take exactly as long as the timeout on its own
   * is never confused with one this function actually killed. */
  readonly timedOut: boolean;
}

export interface CaptureResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type RunTimedLike = (cmd: readonly string[], timeoutMs: number) => Promise<SpawnResult>;
export type RunCapturingLike = (cmd: readonly string[], timeoutMs: number) => Promise<CaptureResult>;

/** Exported so test/unit/wedge-probes-real.test.ts can exercise the real
 * spawn-and-classify machinery directly, against harmless local commands
 * (`true`, `sleep`, `echo`) — zero network, zero credentials, same
 * discipline as every other real-I/O path in this repo — rather than only
 * ever running behind an injected fake. */
export async function defaultRunTimed(cmd: readonly string[], timeoutMs: number): Promise<SpawnResult> {
  const start = Date.now();
  const proc = Bun.spawn([...cmd], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have already exited between the timer firing and this
      // call — not an error worth surfacing.
    }
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, elapsedMs: Date.now() - start, timedOut };
}

/** Exported for the same reason as defaultRunTimed() above. */
export async function defaultRunCapturing(cmd: readonly string[], timeoutMs: number): Promise<CaptureResult> {
  const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // See defaultRunTimed's own comment.
    }
  }, timeoutMs);
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout, timedOut };
}

/**
 * Classifies a direct-path probe's raw process result. "dead" is a
 * POSITIVE claim — see src/wedge.ts's DirectPathObservation comment — and
 * is established two ways, DELIBERATELY NEVER by parsing the tool's own
 * stderr text (locale- and version-dependent; this project verified live,
 * 2026-09-10, that an unresolvable hostname fails in well under 100ms while
 * a real connect-timeout budget is measured in seconds, so timing is a
 * robust, portable signal where stderr parsing would not be):
 *
 * 1. This module's own `timeoutMs` elapsed with no response at all
 *    (`result.timedOut`) — unambiguous: nothing came back within the full
 *    budget this run allowed.
 * 2. The tool exited on its own, after roughly exhausting its OWN
 *    connect-timeout budget (`elapsedMs` within 10% of `connectTimeoutMs`)
 *    — the tool's own timeout, not ours, ran out with nothing back.
 *
 * Anything else — a fast success (exit 0), or a fast NON-zero exit (an
 * unresolvable hostname, a fast connection-refused, a local
 * misconfiguration) — is "unconfirmed", never "dead": a fast response of
 * ANY kind, even a failure, means something answered quickly enough that
 * "no response at all" is not what was observed, and per this repo's
 * refuse-by-default posture, ambiguous evidence must never be read as the
 * positive claim "dead" requires.
 */
export function classifyDirectPath(result: SpawnResult, connectTimeoutMs: number): RawDirectPathReading {
  if (result.timedOut) {
    return {
      outcome: "dead",
      note: `no response within this probe's own ${connectTimeoutMs}ms connect budget`,
    };
  }
  if (result.exitCode === 0) {
    return { outcome: "alive", note: null };
  }
  if (result.elapsedMs >= connectTimeoutMs * 0.9) {
    return {
      outcome: "dead",
      note: `the underlying tool's own connect-timeout budget elapsed with no response (exit ${result.exitCode})`,
    };
  }
  return {
    outcome: "unconfirmed",
    note: `the probe returned quickly (exit ${result.exitCode}, ${result.elapsedMs}ms) — a fast response of any kind is not evidence of "dead"`,
  };
}

function connectSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

function extractJiraUpdated(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const issues = (parsed as Record<string, unknown>)["issues"];
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const first = issues[0];
  if (typeof first !== "object" || first === null) return null;
  const fields = (first as Record<string, unknown>)["fields"];
  if (typeof fields !== "object" || fields === null) return null;
  const updated = (fields as Record<string, unknown>)["updated"];
  if (typeof updated !== "string") return null;
  const parsedMs = Date.parse(updated);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

function extractGitHubCreatedAt(parsed: unknown): number | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (typeof first !== "object" || first === null) return null;
  const createdAt = (first as Record<string, unknown>)["created_at"];
  if (typeof createdAt !== "string") return null;
  const parsedMs = Date.parse(createdAt);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

interface TailscaleSelf {
  Online?: unknown;
}

function extractTailscaleOnline(parsed: unknown): boolean | "unknown" {
  if (typeof parsed !== "object" || parsed === null) return "unknown";
  const self = (parsed as Record<string, unknown>)["Self"] as TailscaleSelf | undefined;
  if (!self || typeof self !== "object") return "unknown";
  return typeof self.Online === "boolean" ? self.Online : "unknown";
}

export interface RealWedgeProbesOptions {
  fetchImpl?: FetchLike;
  runTimed?: RunTimedLike;
  runCapturing?: RunCapturingLike;
}

export class RealWedgeProbes implements WedgeProbes {
  private readonly fetchImpl: FetchLike;
  private readonly runTimed: RunTimedLike;
  private readonly runCapturing: RunCapturingLike;

  constructor(opts: RealWedgeProbesOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.runTimed = opts.runTimed ?? defaultRunTimed;
    this.runCapturing = opts.runCapturing ?? defaultRunCapturing;
  }

  async checkJiraActivity(config: JiraInstrumentConfig): Promise<RawInstrumentReading> {
    const jql = config.projectKey ? `project = "${config.projectKey}" ORDER BY updated DESC` : "ORDER BY updated DESC";
    const url = `${config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=updated`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: config.authHeader, Accept: "application/json" },
      });
    } catch {
      return { outcome: "error", lastSeenAt: null, note: "the request to Jira could not be completed" };
    }

    if (!response.ok) {
      return { outcome: "error", lastSeenAt: null, note: `Jira responded with HTTP ${response.status}` };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { outcome: "error", lastSeenAt: null, note: "Jira's response was not valid JSON" };
    }

    const lastSeenAt = extractJiraUpdated(parsed);
    if (lastSeenAt === null) {
      return {
        outcome: "error",
        lastSeenAt: null,
        note: "Jira's response was not shaped as this project expected (no issues[0].fields.updated)",
      };
    }
    return { outcome: "observed", lastSeenAt, note: null };
  }

  async checkGitHubActivity(config: GitHubInstrumentConfig): Promise<RawInstrumentReading> {
    const path = config.repo ? `/repos/${config.owner}/${config.repo}/events` : `/orgs/${config.owner}/events`;
    const url = `https://api.github.com${path}?per_page=1`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "wyzr-wedge-status",
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch {
      return { outcome: "error", lastSeenAt: null, note: "the request to GitHub could not be completed" };
    }

    if (!response.ok) {
      return { outcome: "error", lastSeenAt: null, note: `GitHub responded with HTTP ${response.status}` };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { outcome: "error", lastSeenAt: null, note: "GitHub's response was not valid JSON" };
    }

    const lastSeenAt = extractGitHubCreatedAt(parsed);
    if (lastSeenAt === null) {
      // An empty array is a well-formed, well-understood case (no events
      // yet observed) — GitHub's events endpoints can legitimately return
      // `[]` for a target with no recent public activity. That is still
      // "no activity observed", not a shape error, so it is reported the
      // same way a truly malformed shape is: no lastSeenAt to report.
      return { outcome: "error", lastSeenAt: null, note: "GitHub's response had no usable events[0].created_at" };
    }
    return { outcome: "observed", lastSeenAt, note: null };
  }

  async checkSsh(config: DirectPathConfig): Promise<RawDirectPathReading> {
    try {
      const result = await this.runTimed(
        ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectSeconds(config.connectTimeoutMs)}`,
          "-o", "StrictHostKeyChecking=accept-new", config.host, "true"],
        config.timeoutMs,
      );
      return classifyDirectPath(result, config.connectTimeoutMs);
    } catch {
      return { outcome: "unconfirmed", note: "could not run the ssh probe at all (e.g. ssh not on PATH)" };
    }
  }

  async checkTunnelPing(config: DirectPathConfig): Promise<RawDirectPathReading> {
    try {
      const result = await this.runTimed(
        ["ping", "-c", "1", "-W", connectSeconds(config.connectTimeoutMs), config.host],
        config.timeoutMs,
      );
      return classifyDirectPath(result, config.connectTimeoutMs);
    } catch {
      return { outcome: "unconfirmed", note: "could not run the ping probe at all (e.g. ping not on PATH)" };
    }
  }

  async checkLocalConnectivity(config: LocalConnectivityConfig): Promise<RawLocalControlReading> {
    try {
      const result = await this.runTimed(["ping", "-c", "1", "-W", connectSeconds(config.timeoutMs), config.target], config.timeoutMs);
      if (result.timedOut) {
        return { outcome: "unhealthy", note: "no reply from the local-connectivity target within budget" };
      }
      if (result.exitCode === 0) {
        return { outcome: "healthy", note: null };
      }
      return { outcome: "unhealthy", note: `ping to the local-connectivity target failed (exit ${result.exitCode})` };
    } catch {
      return { outcome: "error", note: "could not run the local-connectivity probe at all (e.g. ping not on PATH)" };
    }
  }

  async checkControlPlane(config: ControlPlaneConfig): Promise<RawControlPlaneReading> {
    try {
      const result = await this.runCapturing(["tailscale", "status", "--json"], config.timeoutMs);
      if (result.timedOut) {
        return { online: "unknown", note: "tailscale status did not complete within its configured timeout" };
      }
      if (result.exitCode !== 0) {
        return { online: "unknown", note: `tailscale status exited ${result.exitCode}` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { online: "unknown", note: "tailscale status --json did not print valid JSON" };
      }
      return { online: extractTailscaleOnline(parsed), note: null };
    } catch {
      return { online: "unknown", note: "could not run tailscale at all (e.g. not installed)" };
    }
  }
}
