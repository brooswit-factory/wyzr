// Orchestrates a single `wyzr wedge status` run: reads a WedgeConfig, calls
// every CONFIGURED probe through the injectable WedgeProbes boundary
// (src/wedge-probes.ts) with its own timeout enforced here (never inside
// src/wedge.ts, which does no I/O at all), assembles the result into the
// shapes src/wedge.ts's pure evaluateWedge() expects, and returns its
// WedgeResult unchanged. Same role as src/auth-session.ts: written against
// an interface, never a concrete transport, so this whole module is
// exercisable with FakeWedgeProbes and zero network/credentials — see
// test/unit/wedge-runner.test.ts.
//
// PUBLISHED INTERFACE (WYZR-16's "what later stories inherit from your
// shape" — WYZR-19, `wyzr cycle`, calls this engine and is forbidden from
// widening it): `runWedgeCheck()` and `RunWedgeCheckOptions` are how a
// non-CLI caller runs the full check and gets a `WedgeResult` back to
// switch on — it needs nothing from src/cli-wedge.ts. Everything else in
// this file (the `attempt()`/`toXObservation()` helpers) is internal and
// free to change.

import { registerSecret } from "./redact.ts";
import {
  evaluateWedge,
  type ControlPlaneReading,
  type DirectPathObservation,
  type InstrumentObservation,
  type LocalConnectivityObservation,
  type WedgeResult,
} from "./wedge.ts";
import type {
  RawControlPlaneReading,
  RawDirectPathReading,
  RawInstrumentReading,
  RawLocalControlReading,
  WedgeProbes,
} from "./wedge-probes.ts";
import {
  DEFAULT_QUIET_THRESHOLD_MS,
  GITHUB_INSTRUMENT_NAME,
  JIRA_INSTRUMENT_NAME,
  MANAGER_INTERNET_DEPENDENCY,
  SSH_DIRECT_PATH_NAME,
  TUNNEL_PING_DIRECT_PATH_NAME,
  type WedgeConfig,
} from "./wedge-config.ts";

export type Attempt<T> = { kind: "ok"; value: T } | { kind: "timeout" } | { kind: "error"; message: string };

/**
 * Races `run()` against `timeoutMs`, enforced HERE rather than trusted to
 * whatever `run()` does internally — a probe implementation that never
 * settles (a hung TCP connect, a hung fetch) must still produce a
 * `"timeout"` outcome rather than hanging `wyzr wedge status` forever. Any
 * synchronous throw or rejection from `run()` is caught and reported as
 * `"error"`, never left to propagate — a single probe's failure must never
 * take down the whole evidence-gathering run (see runWedgeCheck() below,
 * which runs every probe concurrently via Promise.all).
 */
// Exported (WYZR-25) so src/recovery-runner.ts can reuse this same
// race-against-a-timeout wrapper rather than duplicating it — this helper is
// "internal, free to change" per README's published-interface section.
export async function attempt<T>(run: () => Promise<T>, timeoutMs: number): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Attempt<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const runPromise: Promise<Attempt<T>> = (async () => {
    try {
      const value = await run();
      return { kind: "ok", value };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  })();

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toInstrumentObservation(
  name: string,
  dependsOn: readonly string[],
  quietThresholdMs: number,
  result: Attempt<RawInstrumentReading> | "unconfigured",
): InstrumentObservation {
  const base = { __brand: "wedge-instrument" as const, name, dependsOn, quietThresholdMs };
  if (result === "unconfigured") {
    return { ...base, outcome: "unconfigured", lastSeenAt: null, note: "not configured — no operator-supplied target for this instrument" };
  }
  if (result.kind === "timeout") {
    return { ...base, outcome: "timeout", lastSeenAt: null, note: "probe did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, outcome: "error", lastSeenAt: null, note: result.message };
  }
  if (result.value.outcome !== "observed") {
    return { ...base, outcome: result.value.outcome, lastSeenAt: null, note: result.value.note };
  }
  return { ...base, outcome: "observed", lastSeenAt: result.value.lastSeenAt, note: result.value.note };
}

function toDirectPathObservation(
  name: string,
  result: Attempt<RawDirectPathReading> | "unconfigured",
): DirectPathObservation {
  const base = { __brand: "wedge-direct-path" as const, name };
  if (result === "unconfigured") {
    return { ...base, outcome: "unconfirmed", note: "not configured — no operator-supplied host for this direct path" };
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

/** Unlike toInstrumentObservation()/toDirectPathObservation() above, this
 * has no "unconfigured" case to handle: the control-plane reading has no
 * quorum role (src/wedge.ts's ControlPlaneReading is recorded only), so an
 * unconfigured control-plane is simply OMITTED from the evidence trail by
 * this function's only caller below, rather than reported as an
 * "unconfigured" row the way an instrument or direct path is. */
function toControlPlaneReading(name: string, result: Attempt<RawControlPlaneReading>): ControlPlaneReading {
  const base = { __brand: "wedge-control-plane" as const, name };
  if (result.kind === "timeout") {
    return { ...base, online: "unknown", note: "the control-plane check did not complete within its configured timeout" };
  }
  if (result.kind === "error") {
    return { ...base, online: "unknown", note: result.message };
  }
  return { ...base, online: result.value.online, note: result.value.note };
}

export interface RunWedgeCheckOptions {
  readonly config: WedgeConfig;
  readonly probes: WedgeProbes;
  /** Epoch ms "now" — defaults to Date.now(); injectable so a test can pin
   * quiet-duration math, the same role src/auth-session.ts's `nonce`
   * injection plays for a different kind of determinism. */
  readonly now?: number;
}

/**
 * Gathers every configured probe's reading (concurrently, each under its
 * own configured timeout) and hands the assembled WedgeInput to
 * src/wedge.ts's evaluateWedge() — the one and only place a verdict is
 * decided. This function performs I/O (through `probes`); evaluateWedge()
 * itself never does.
 */
export async function runWedgeCheck(options: RunWedgeCheckOptions): Promise<WedgeResult> {
  const { config, probes } = options;
  const now = options.now ?? Date.now();

  // Registered before any probe runs, so there is no window in which a
  // credential could reach output before it is protected — same discipline
  // as src/credentials.ts's loadCredentials().
  registerSecret(config.jira?.authHeader);
  registerSecret(config.github?.token);

  const jira = config.jira;
  const github = config.github;
  const ssh = config.ssh;
  const tunnelPing = config.tunnelPing;
  const controlPlaneConfig = config.controlPlane;

  const [jiraAttempt, githubAttempt, sshAttempt, tunnelAttempt, localAttempt, controlPlaneAttempt] = await Promise.all([
    jira ? attempt(() => probes.checkJiraActivity(jira), jira.timeoutMs) : Promise.resolve("unconfigured" as const),
    github ? attempt(() => probes.checkGitHubActivity(github), github.timeoutMs) : Promise.resolve("unconfigured" as const),
    ssh ? attempt(() => probes.checkSsh(ssh), ssh.timeoutMs) : Promise.resolve("unconfigured" as const),
    tunnelPing
      ? attempt(() => probes.checkTunnelPing(tunnelPing), tunnelPing.timeoutMs)
      : Promise.resolve("unconfigured" as const),
    attempt(() => probes.checkLocalConnectivity(config.localConnectivity), config.localConnectivity.timeoutMs),
    controlPlaneConfig
      ? attempt(() => probes.checkControlPlane(controlPlaneConfig), controlPlaneConfig.timeoutMs)
      : Promise.resolve("unconfigured" as const),
  ]);

  // Every instrument/direct-path slot is ALWAYS represented in the
  // evidence trail — configured or not. Omitting an unconfigured slot
  // entirely would mean "jira-activity" simply never appears in
  // `wyzr wedge status`'s output instead of appearing as UNCONFIGURED,
  // which is exactly the silent-disappearance the ticket's "an
  // unconfigured instrument must report itself unconfigured" rule exists
  // to prevent — reporting requires the slot to exist. The canonical
  // name/dependsOn used when unconfigured come from src/wedge-config.ts so
  // the SAME name is shown whether or not the operator has configured it.
  const instruments: InstrumentObservation[] = [
    jira
      ? toInstrumentObservation(jira.name, jira.dependsOn, jira.quietThresholdMs, jiraAttempt)
      : toInstrumentObservation(JIRA_INSTRUMENT_NAME, [MANAGER_INTERNET_DEPENDENCY], DEFAULT_QUIET_THRESHOLD_MS, "unconfigured"),
    github
      ? toInstrumentObservation(github.name, github.dependsOn, github.quietThresholdMs, githubAttempt)
      : toInstrumentObservation(GITHUB_INSTRUMENT_NAME, [MANAGER_INTERNET_DEPENDENCY], DEFAULT_QUIET_THRESHOLD_MS, "unconfigured"),
  ];

  const directPaths: DirectPathObservation[] = [
    ssh ? toDirectPathObservation(ssh.name, sshAttempt) : toDirectPathObservation(SSH_DIRECT_PATH_NAME, "unconfigured"),
    tunnelPing
      ? toDirectPathObservation(tunnelPing.name, tunnelAttempt)
      : toDirectPathObservation(TUNNEL_PING_DIRECT_PATH_NAME, "unconfigured"),
  ];

  const localControl = toLocalControlObservation(
    config.localConnectivity.name,
    config.localConnectivity.confirms,
    localAttempt,
  );

  // `controlPlaneAttempt` is only ever "unconfigured" when `controlPlaneConfig`
  // is falsy (both come from the same ternary condition in the Promise.all
  // above) — this cast makes that correlation explicit at the one call site
  // that relies on it, rather than re-threading an "unconfigured" case
  // through toControlPlaneReading() for a state it can never actually see.
  const controlPlane: ControlPlaneReading[] = controlPlaneConfig
    ? [toControlPlaneReading(controlPlaneConfig.name, controlPlaneAttempt as Attempt<RawControlPlaneReading>)]
    : [];

  return evaluateWedge({ now, instruments, directPaths, localControl, controlPlane });
}
