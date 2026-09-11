// The post-cycle recovery engine: a PURE, injectable-boundary library
// module, built directly on src/wedge.ts's own shape (pure-engine/runner
// split, `now` injected, no I/O). It takes already-gathered observations IN
// and produces a verdict plus its full evidence trail OUT. See
// src/recovery-probes.ts for the injectable boundary that gathers the
// NEW observations this module consumes beyond what src/wedge-probes.ts
// already provides (src/recovery-runner.ts is the orchestrator that calls
// both boundaries and hands this module its input).
//
// THE ONE QUESTION EVERY LINE OF THIS MODULE MUST ANSWER TRUTHFULLY (the
// ticket's own framing, after WYZR-16 was bounced twice for exactly this):
// is a claim here true about what was OBSERVED, or only about what was
// ATTEMPTED? Every verdict branch below traces to a raw observation; none
// infers one check's pass from another's (named test 8).
//
// THE CLOCK IS AN INPUT, NOT AN AMBIENT CALL — same discipline as
// src/wedge.ts, same reason: `RecoveryInput.now`/`.since` are the only time
// this module reads, so quiet/elapsed-duration math can be tested exactly
// AT a boundary, not just near one with a tolerance.
//
// THE FIVE CHECKS, each reporting independently rather than collapsing
// early, each able to say "could not look" (CheckOutcome = "pass" | "fail"
// | "could-not-look" | "not-configured" — the SAME four-way vocabulary the
// epic's ruling requires of the top-level verdict itself, applied uniformly
// to every check that feeds it):
//
// 1. REACHABILITY (assessReachability). Reuses WYZR-16's ssh/tunnel-ping
//    raw outcome vocabulary ("alive"/"dead"/"unconfirmed") via
//    src/recovery-runner.ts, which calls WedgeProbes.checkSsh/
//    checkTunnelPing directly — no second pair of probes. An "alive" path
//    is direct, unconfounded evidence (a broken local connection can
//    SUPPRESS a reply but cannot MANUFACTURE one) and passes on its own.
//    Silence (every configured path dead/unconfirmed) is CONFOUNDED — it
//    could be the box, or it could be the manager's own internet — so it
//    only becomes an affirmative "fail" once the local-connectivity control
//    is read and healthy; otherwise it is "could-not-look" (named test 11).
// 2. REBOOT (assessReboot). The hard one. The baseline is the caller-
//    supplied power-off instant (`RecoveryInput.since`) — never a
//    before/after boot-time comparison, which is unimplementable (a wedged
//    box cannot be read BEFORE the cut). The property required: a box whose
//    clock is behind or ahead must produce neither a false PASS nor a false
//    FAIL. This module NEVER compares two wall-clock instants across
//    machines to satisfy that — it compares two DURATIONS, each measured on
//    ONE clock: the box's own uptime (src/recovery-probes.ts's
//    `RawUptimeReading.uptimeMs`, read from the box's own monotonic
//    counter — see src/recovery-probes-real.ts's top comment for how) against
//    `elapsedMs = now - since` (measured entirely on the manager's own
//    clock). `uptimeMs < elapsedMs` means the box booted after the cut;
//    `uptimeMs >= elapsedMs` means it has been up since before the cut, so
//    it never rebooted — an AFFIRMATIVE failure, unconfounded by
//    construction (reading uptime at all requires ssh to have already
//    answered), so unlike reachability's silence it needs no
//    local-connectivity gate (named test 11's second half). A reading that
//    could not be obtained or parsed is "could-not-look," never a pass or a
//    fail, and NEVER falls back to a wall-clock method (named test 1/2/3).
// 3. DAEMON (assessDaemon). Four distinguishable raw outcomes (see
//    src/recovery-probes.ts's `RawDaemonReading`) collapse to this check's
//    four-way CheckOutcome: healthy→pass, unhealthy→fail,
//    pointed-at-nothing→could-not-look (a wrong scope means we looked in
//    the wrong place, not that we found it unhealthy — named test 7),
//    error/timeout→could-not-look, not-configured→not-configured.
// 4. INSTRUMENTS (assessInstruments). Reuses WYZR-16's Jira-/GitHub-
//    activity probes verbatim. An instrument counts as RESUMED only if its
//    last observed activity is AFTER `RecoveryInput.since` — activity from
//    before the cut proves nothing about recovery (named test 10). At least
//    one configured instrument resuming is enough to pass (an outbound
//    write is not confounded by the manager's own connectivity the way
//    SILENCE is — see reachability above — so, unlike reachability, this
//    needs no local-connectivity gate of its own). All configured
//    instruments still silent is an affirmative fail, even when ssh
//    returned (named test 9).
// 5. FLEET (assessFleet). Reuses nothing from WYZR-16 — a wholly new probe
//    (src/recovery-probes.ts's `checkFleetAudit`) because this is the
//    herdr-bare-restore trap, specific to this story. Zero candidates found
//    is its own affirmative fail ("the fleet did not come back," distinct
//    from "could not look"); one or more BARE candidates is a fail that
//    ALSO sets `hasBare: true`, which evaluateRecovery() below can promote
//    to the FLEET_HALF_RESTORED verdict when the box itself is otherwise
//    confirmed back (named test 6). Never sees the raw process list itself
//    — see src/recovery-probes.ts's `RawFleetAuditReading` for why the type
//    alone makes a leak structurally impossible here.
//
// STRUCTURALLY EXCLUDED: PLUG/CONTROL-PLANE LIVENESS. See
// `PlugLivenessReading` below — mirrors src/wedge.ts's `ControlPlaneReading`
// exactly, for the identical reason (named test 4/5).
//
// PRECEDENCE — see evaluateRecovery()'s own comment for the five rules, in
// the order the ticket states them, each with the reasoning that justifies
// it rather than just the rule.

import type { LocalConnectivityObservation } from "./wedge.ts";

export const RecoveryVerdict = {
  Recovered: "RECOVERED",
  NotRecovered: "NOT_RECOVERED",
  FleetHalfRestored: "FLEET_HALF_RESTORED",
  Inconclusive: "INCONCLUSIVE",
  Unconfigured: "UNCONFIGURED",
} as const;
export type RecoveryVerdict = (typeof RecoveryVerdict)[keyof typeof RecoveryVerdict];

/** The uniform vocabulary every one of the five checks reports in, and the
 * same vocabulary the top-level verdict's own precedence is built from — see
 * this module's top comment. */
export type CheckOutcome = "pass" | "fail" | "could-not-look" | "not-configured";

export type RecoveryDirectPathRawOutcome = "alive" | "dead" | "unconfirmed";

/** ssh / tunnel-ping, reused verbatim from WYZR-16 — see this module's top
 * comment, check 1. */
export interface RecoveryDirectPathObservation {
  readonly __brand: "recovery-direct-path";
  readonly name: string;
  readonly outcome: RecoveryDirectPathRawOutcome | "not-configured";
  readonly note: string | null;
}

/** The reboot check's raw uptime reading — see this module's top comment,
 * check 2, and src/recovery-probes.ts's `RawUptimeReading`. */
export interface RecoveryUptimeObservation {
  readonly __brand: "recovery-uptime";
  readonly outcome: "observed" | "error" | "timeout" | "not-configured";
  readonly uptimeMs: number | null;
  readonly note: string | null;
}

/** The daemon check's raw reading — see this module's top comment, check 3,
 * and src/recovery-probes.ts's `RawDaemonReading`. `unit`/`scope` are
 * carried through so a reader can tell WHAT was actually examined — the
 * ticket's own requirement. */
export interface RecoveryDaemonObservation {
  readonly __brand: "recovery-daemon";
  readonly outcome: "healthy" | "unhealthy" | "pointed-at-nothing" | "error" | "timeout" | "not-configured";
  readonly unit: string | null;
  readonly scope: "user" | "system" | null;
  readonly note: string | null;
}

/** One outside instrument (Jira-/GitHub-activity), reused verbatim from
 * WYZR-16 — see this module's top comment, check 4. */
export interface RecoveryInstrumentObservation {
  readonly __brand: "recovery-instrument";
  readonly name: string;
  readonly outcome: "observed" | "error" | "timeout" | "not-configured";
  readonly lastSeenAt: number | null;
  readonly note: string | null;
}

/** The fleet-pane-audit's raw reading — COUNTS ONLY, structurally; see
 * src/recovery-probes.ts's `RawFleetAuditReading` for why. */
export interface RecoveryFleetObservation {
  readonly __brand: "recovery-fleet";
  readonly outcome: "enumerated" | "error" | "timeout" | "not-configured";
  readonly totalCandidates: number | null;
  readonly flaggedCount: number | null;
  readonly bareCount: number | null;
  readonly note: string | null;
}

/**
 * A liveness-only reading about the PLUG (`P5`/`conn_state`) or ANY other
 * signal that is live-but-says-nothing-about-the-box. `wyzr recovery
 * status` reads no such thing at all — see README's "STRUCTURALLY
 * EXCLUDED: PLUG LIVENESS" section for the two reasons (a structurally
 * powerless signal is not worth fetching, and fetching it would require
 * importing this repo's Wyze transport/plug modules — precisely what the
 * structural read-only test forbids). This type is exported, and this
 * module imports/references it in exactly one place (the `@ts-expect-error`
 * proof in test/unit/recovery.test.ts), ONLY so a future caller that DOES
 * hold one (WYZR-19's `wyzr cycle`, which calls this engine and is the
 * realistic party who would pass one in) cannot assign it into any
 * evidence collection below — the exact `Online=True`/P5 failure this
 * whole product exists to prevent, reproduced one level up. Mirrors
 * src/wedge.ts's `ControlPlaneReading` exactly: none of this shape's fields
 * overlap any observation type above, and the `__brand` tag keeps that
 * true even in a hypothetical future where the rest of the shape happened
 * to converge.
 */
export interface PlugLivenessReading {
  readonly __brand: "recovery-plug-liveness";
  readonly online: boolean | "unknown";
  readonly note: string | null;
}

export interface RecoveryInput {
  /** Epoch ms "now" — injected, same reasoning as src/wedge.ts's
   * `WedgeInput.now`. */
  readonly now: number;
  /** Epoch ms the power-off itself was performed — REQUIRED, the reboot
   * check's baseline (this module's top comment, check 2). Validated as
   * present and not future-dated by src/cli-recovery.ts BEFORE this module
   * ever sees it — a Usage error, not a verdict. */
  readonly since: number;
  readonly reachability: readonly RecoveryDirectPathObservation[];
  readonly localControl: LocalConnectivityObservation;
  readonly uptime: RecoveryUptimeObservation;
  readonly daemon: RecoveryDaemonObservation;
  readonly instruments: readonly RecoveryInstrumentObservation[];
  readonly fleet: RecoveryFleetObservation;
}

export interface RecoveryChecks {
  readonly reachability: CheckOutcome;
  readonly reboot: CheckOutcome;
  readonly daemon: CheckOutcome;
  readonly instruments: CheckOutcome;
  readonly fleet: CheckOutcome;
}

export interface RecoveryResult {
  readonly verdict: RecoveryVerdict;
  /** The full evidence trail's prose, in the order it was decided — same
   * "evidence is the product, the verdict is a summary of it" requirement
   * as src/wedge.ts's `WedgeResult.reasons`. */
  readonly reasons: readonly string[];
  readonly reachability: readonly RecoveryDirectPathObservation[];
  readonly localControl: LocalConnectivityObservation;
  readonly uptime: RecoveryUptimeObservation;
  /** `now - since`, computed once, here — the single source of truth for
   * "how long has it been since the cut" that both the reboot check and
   * (if ever needed) a caller's own display use. */
  readonly elapsedMs: number;
  readonly daemon: RecoveryDaemonObservation;
  readonly instruments: readonly RecoveryInstrumentObservation[];
  readonly fleet: RecoveryFleetObservation;
  readonly checks: RecoveryChecks;
}

function assessReachability(
  paths: readonly RecoveryDirectPathObservation[],
  localControl: LocalConnectivityObservation,
  reasons: string[],
): CheckOutcome {
  const configured = paths.filter((p) => p.outcome !== "not-configured");
  if (configured.length === 0) {
    reasons.push('reachability: not configured — no direct path (ssh, tunnel-ping) has an operator-supplied host');
    return "not-configured";
  }

  const alive = configured.filter((p) => p.outcome === "alive");
  if (alive.length > 0) {
    for (const p of alive) {
      reasons.push(
        `reachability: direct path "${p.name}" read "alive" — direct, unconfounded evidence the box is ` +
          "reachable (a broken local connection can suppress a reply, never manufacture one)",
      );
    }
    return "pass";
  }

  // Every configured path is dead/unconfirmed — SILENCE, and silence is
  // confounded: our own connectivity failing makes a healthy box look
  // silent too (this module's top comment, check 1). A NOT_RECOVERED
  // resting only on this must be gated on the local-connectivity control
  // having been read and healthy — named test 11.
  if (localControl.outcome === "healthy") {
    reasons.push(
      "reachability: no configured direct path is alive, and the local-connectivity control is healthy — " +
        "this silence is not attributable to our own connection, so it is an affirmative failure",
    );
    return "fail";
  }
  reasons.push(
    `reachability: no configured direct path is alive, but the local-connectivity control is ` +
      `"${localControl.outcome}", not healthy — this silence is confounded (it could be our own connection, ` +
      "not the box) and must not be read as an affirmative failure",
  );
  return "could-not-look";
}

function assessReboot(
  uptime: RecoveryUptimeObservation,
  since: number,
  now: number,
  reasons: string[],
): { outcome: CheckOutcome; elapsedMs: number } {
  const elapsedMs = now - since;

  if (uptime.outcome === "not-configured") {
    reasons.push("reboot: not configured (no ssh host to read the box's uptime from)");
    return { outcome: "not-configured", elapsedMs };
  }
  if (uptime.outcome !== "observed" || uptime.uptimeMs === null) {
    reasons.push(
      `reboot: could not read the box's uptime (${uptime.outcome})${uptime.note ? ` — ${uptime.note}` : ""} — ` +
        "never a pass, never a fail",
    );
    return { outcome: "could-not-look", elapsedMs };
  }

  // Two DURATIONS, each from one clock — never a cross-machine INSTANT
  // comparison (this module's top comment, check 2). This is what makes
  // clock skew, in either direction, incapable of producing a false PASS
  // or a false FAIL.
  if (uptime.uptimeMs < elapsedMs) {
    reasons.push(
      `reboot: uptime (${uptime.uptimeMs}ms) is less than the elapsed time since the cut (${elapsedMs}ms) — ` +
        "the box booted after power was cut",
    );
    return { outcome: "pass", elapsedMs };
  }
  reasons.push(
    `reboot: uptime (${uptime.uptimeMs}ms) is NOT less than the elapsed time since the cut (${elapsedMs}ms) — ` +
      "the box has been up since before the cut and never rebooted (this is what catches the cycle verb " +
      "silently no-opping)",
  );
  return { outcome: "fail", elapsedMs };
}

function assessDaemon(daemon: RecoveryDaemonObservation, reasons: string[]): CheckOutcome {
  const where = `unit "${daemon.unit ?? "(none)"}" (scope: ${daemon.scope ?? "(none)"})`;
  switch (daemon.outcome) {
    case "not-configured":
      reasons.push("daemon: not configured (no unit/scope supplied — neither has a default)");
      return "not-configured";
    case "healthy":
      reasons.push(`daemon: ${where} is healthy`);
      return "pass";
    case "unhealthy":
      reasons.push(`daemon: ${where} is unhealthy${daemon.note ? ` — ${daemon.note}` : ""}`);
      return "fail";
    case "pointed-at-nothing":
      reasons.push(
        `daemon: ${where} does not exist under that scope — this is what a WRONG SCOPE looks like, ` +
          `never read as "unhealthy"; could not actually look at the daemon's health`,
      );
      return "could-not-look";
    case "error":
    case "timeout":
      reasons.push(`daemon: could not look (${daemon.outcome})${daemon.note ? ` — ${daemon.note}` : ""}`);
      return "could-not-look";
  }
}

function assessInstruments(
  instruments: readonly RecoveryInstrumentObservation[],
  since: number,
  reasons: string[],
): CheckOutcome {
  const configured = instruments.filter((i) => i.outcome !== "not-configured");
  if (configured.length === 0) {
    reasons.push("instruments: not configured — no outside instrument (jira-activity, github-activity) has a target");
    return "not-configured";
  }

  let anyResumed = false;
  let anyUnreadable = false;
  for (const i of configured) {
    if (i.outcome !== "observed" || i.lastSeenAt === null) {
      anyUnreadable = true;
      reasons.push(`instruments: "${i.name}" could not be read (${i.outcome})${i.note ? ` — ${i.note}` : ""}`);
      continue;
    }
    // An instrument counts as RESUMED only if its last observed activity is
    // AFTER the cut — activity from before it is the old world's activity
    // and proves nothing about recovery (this module's top comment, check
    // 4; named test 10 — the trap a naive port of WYZR-16's own
    // quiet-threshold rule walks into unchanged).
    if (i.lastSeenAt > since) {
      anyResumed = true;
      reasons.push(`instruments: "${i.name}" resumed — last activity ${new Date(i.lastSeenAt).toISOString()} is after the cut`);
    } else {
      reasons.push(
        `instruments: "${i.name}" has NOT resumed — last activity ${new Date(i.lastSeenAt).toISOString()} ` +
          "predates the cut, so it proves nothing about recovery",
      );
    }
  }

  if (anyResumed) return "pass";
  if (anyUnreadable) {
    reasons.push("instruments: no configured instrument affirmatively resumed, and at least one could not be read");
    return "could-not-look";
  }
  reasons.push(
    "instruments: every configured instrument is still silent since before the cut — an affirmative failure, " +
      "even if ssh has already returned (named test 9)",
  );
  return "fail";
}

function assessFleet(fleet: RecoveryFleetObservation, reasons: string[]): { outcome: CheckOutcome; hasBare: boolean } {
  if (fleet.outcome === "not-configured") {
    reasons.push("fleet: not configured (no process-match/expected-flags supplied — neither has a default)");
    return { outcome: "not-configured", hasBare: false };
  }
  if (fleet.outcome !== "enumerated" || fleet.totalCandidates === null || fleet.flaggedCount === null || fleet.bareCount === null) {
    reasons.push(`fleet: could not enumerate agent processes (${fleet.outcome})${fleet.note ? ` — ${fleet.note}` : ""}`);
    return { outcome: "could-not-look", hasBare: false };
  }

  // The denominator is ALWAYS reported alongside the counts — "0 bare
  // panes found" is only meaningful next to a denominator that could have
  // contained one (this module's top comment, check 5).
  reasons.push(
    `fleet: ${fleet.totalCandidates} candidate agent process(es) found — ${fleet.flaggedCount} fully flagged, ` +
      `${fleet.bareCount} bare`,
  );

  if (fleet.totalCandidates === 0) {
    reasons.push('fleet: zero agent processes found — "the fleet did not come back," a different finding from "could not look"');
    return { outcome: "fail", hasBare: false };
  }
  if (fleet.bareCount > 0) {
    reasons.push(
      `fleet: ${fleet.bareCount} of ${fleet.totalCandidates} candidate process(es) are bare (missing the ` +
        "configured expected spawn flags) — the herdr-restore trap",
    );
    return { outcome: "fail", hasBare: true };
  }
  reasons.push("fleet: every candidate agent process carries the expected spawn flags");
  return { outcome: "pass", hasBare: false };
}

/**
 * The engine's single entry point. Never throws on malformed-but-typed
 * input (no I/O here to fail) — every branch below is total over
 * RecoveryInput's type.
 *
 * PRECEDENCE, in this exact order (the ticket's own rules, each with why):
 *
 * 1. FLEET_HALF_RESTORED, its own distinguishable verdict — ONLY when the
 *    box itself is affirmatively confirmed back (reachability AND reboot
 *    both "pass" — "never report half-restored about a box you have no
 *    evidence returned") AND the fleet check's own failure is specifically
 *    the bare-panes shape AND no OTHER check (daemon, instruments)
 *    affirmatively failed too ("a failure of the box itself outranks the
 *    fleet's shape" — daemon/instrument health is about the box, so a
 *    genuine problem there is not excused by the box being reachable).
 * 2. NOT_RECOVERED whenever ANY check affirmatively failed and rule 1 did
 *    not already apply — "an affirmative failure outranks an absence."
 * 3. INCONCLUSIVE when nothing failed but at least one check could not be
 *    read — "a could-not-look outranks an unconfigured gap": "I looked and
 *    could not see" carries possible information about the box; "you never
 *    told me where to look" carries none.
 * 4. UNCONFIGURED when nothing failed and nothing was unreadable, and the
 *    only gaps are checks nobody pointed anywhere.
 * 5. RECOVERED only when every check affirmatively passed.
 *
 * Neither "could-not-look" nor "not-configured" is EVER upgraded to a pass
 * or downgraded to a fail (named test 12) — only an actual per-check "fail"
 * can reach branch 2, and only "pass" across the board reaches branch 5.
 */
export function evaluateRecovery(input: RecoveryInput): RecoveryResult {
  const reasons: string[] = [];

  const reachability = assessReachability(input.reachability, input.localControl, reasons);
  const { outcome: reboot, elapsedMs } = assessReboot(input.uptime, input.since, input.now, reasons);
  const daemon = assessDaemon(input.daemon, reasons);
  const instruments = assessInstruments(input.instruments, input.since, reasons);
  const { outcome: fleet, hasBare } = assessFleet(input.fleet, reasons);

  const checks: RecoveryChecks = { reachability, reboot, daemon, instruments, fleet };
  const base = {
    reachability: input.reachability,
    localControl: input.localControl,
    uptime: input.uptime,
    elapsedMs,
    daemon: input.daemon,
    instruments: input.instruments,
    fleet: input.fleet,
    checks,
  };

  const boxConfirmedBack = reachability === "pass" && reboot === "pass";
  const otherChecksFailed = daemon === "fail" || instruments === "fail";

  if (boxConfirmedBack && hasBare && !otherChecksFailed) {
    reasons.push(
      "VERDICT: FLEET_HALF_RESTORED — the box is affirmatively back and rebooted, but the fleet came back with " +
        "bare (un-flagged) agent processes present; wyzr detects and reports this, it does not fix it",
    );
    return { verdict: RecoveryVerdict.FleetHalfRestored, reasons, ...base };
  }

  const outcomes = new Set<CheckOutcome>([reachability, reboot, daemon, instruments, fleet]);

  if (outcomes.has("fail")) {
    reasons.push("VERDICT: NOT_RECOVERED — at least one check affirmatively failed");
    return { verdict: RecoveryVerdict.NotRecovered, reasons, ...base };
  }

  if (outcomes.has("could-not-look")) {
    reasons.push("VERDICT: INCONCLUSIVE — nothing affirmatively failed, but at least one check could not be read");
    return { verdict: RecoveryVerdict.Inconclusive, reasons, ...base };
  }

  if (outcomes.has("not-configured")) {
    reasons.push("VERDICT: UNCONFIGURED — nothing failed and nothing was unreadable; the only gaps are checks never pointed anywhere");
    return { verdict: RecoveryVerdict.Unconfigured, reasons, ...base };
  }

  reasons.push("VERDICT: RECOVERED — every configured check affirmatively passed");
  return { verdict: RecoveryVerdict.Recovered, reasons, ...base };
}
