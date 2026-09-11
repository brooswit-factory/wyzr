// Orchestrates a single `wyzr cycle` run — the I/O layer that performs the
// sequence R4 names: evaluate the gate -> wrong-box guard -> cloud +
// plug-state preconditions -> OFF -> wait -> ON with the never-give-up
// restore -> recovery verdict via WYZR-18 -> report. Every step's outcome
// is recorded as evidence (never collapsed into a boolean) into the
// `reasons` trail and into its own field on the returned CycleResult
// (src/cycle.ts).
//
// WHY THIS FILE, NOT A wedge.ts/wedge-runner.ts-SHAPED SPLIT: src/wedge.ts's
// evaluateWedge() is a single pure function because a wedge verdict really
// is "gather everything, then decide once." `wyzr cycle` is not that shape
// — it is a PROCEDURE with real actions gated at specific points (the OFF
// must happen at most once; the restore must always follow an attempted
// OFF; a write must never be reachable from the dry-run path at all). Two
// pieces ARE extracted as genuinely pure/injectable, on this repo's
// established pattern: src/cycle.ts's decideGate() (pure, switches on the
// gate's verdict VALUE) and src/cycle-wrong-box.ts's own
// pure-engine/impure-runner pair, evaluateWrongBoxGuard()/runWrongBoxGuard()
// (the guard resolves real network-address evidence through its own
// injectable WrongBoxIdentityProbe boundary — see that module's own top
// comment for why a hostname-string comparison alone can never be made to
// work here). Everything below is the I/O that gathers their inputs and
// carries out what they decide — same role src/wedge-runner.ts/
// src/recovery-runner.ts play for their own engines, and this module calls
// BOTH of those runners unchanged (runWedgeCheck(), runRecoveryCheck())
// rather than re-deriving either verdict.
//
// TWO ENTRY POINTS, NOT ONE WITH A `dryRun: boolean` PARAMETER — this is
// R5's structural requirement made concrete: runCycleDryRun() accepts a
// `PlugReader`; runCycleLive() accepts a `PlugWriter`. A write call
// anywhere in runCycleDryRun()'s body does not typecheck, because a
// PlugReader has no writePower() method — not because a runtime flag
// happens to guard the call. Both share runPreamble() below (gate + guard +
// preconditions), which itself only ever takes a PlugReader — the
// preconditions check is a READ, never a write, on every path.
//
// REFUSAL PRIORITY, WHEN MORE THAN ONE PREAMBLE CHECK WOULD REFUSE: this
// module evaluates the gate, the wrong-box guard, AND the preconditions
// UNCONDITIONALLY, every run (dry or live) — never short-circuits gathering
// any of the three, so a human reading a refused dry-run sees the FULL
// picture (R5's own bar: "someone must be able to watch the gate decide NO
// ... and see exactly why"), and so the precondition check runs even when
// the gate has already refused and force was not given, which is what lets
// the ticket's own "force + NOT_PROVEN + cloud unreachable -> still
// refuses" case (test 5, "the most important test in this story") hold
// even though the gate's OWN refusal would have been overridden by force.
// When more than one preamble check would refuse, the REPORTED outcome
// follows this priority: wrong-box guard, then preconditions, then the
// gate. This is deliberate, not arbitrary: D7 gives the wrong-box guard "no
// escape hatch, anywhere, under any flag" — stronger language than D4 uses
// for the preconditions — and D4 makes the preconditions a CAPABILITY force
// can never touch, while the gate's own refusal is the ONE thing force CAN
// override. Reporting in weakest-to-strongest order (gate last) means the
// outcome you see is always the strongest reason the run could not proceed,
// never a weaker one masking a stronger one that force cannot fix anyway.
//
// EXPORTED FOR REUSE (WYZR-20/WYZR-30): performOff()/performRestoreNeverGiveUp()/
// describeOff()/describeRestore() are the at-most-once-OFF, never-give-up-ON
// primitives — generic over PlugWriter/CycleClock/CycleTimingConfig/
// PreconditionsClearedWitness, with nothing gate/wrong-box/recovery-specific
// in their own bodies. src/rehearsal-runner.ts (the first plug write this
// product ever performs, on the SAFE plug — see that module's own top
// comment) reuses these UNCHANGED rather than re-deriving the same
// restore-is-structurally-unskippable reasoning a second time: "a rewrite
// can silently lose a property the code it replaced had" applies most
// sharply to exactly this code, so there is no second copy to drift from
// this one. This is an additive visibility change only (`function` ->
// `export function`) — no behavior here is altered, and this module's own
// runCycleDryRun()/runCycleLive() call these exact same exported functions,
// not a parallel internal copy.

import { runWedgeCheck } from "./wedge-runner.ts";
import type { WedgeConfig } from "./wedge-config.ts";
import type { WedgeProbes } from "./wedge-probes.ts";
import { runRecoveryCheck } from "./recovery-runner.ts";
import type { RecoveryConfig } from "./recovery-config.ts";
import type { RecoveryProbes } from "./recovery-probes.ts";
import { RecoveryVerdict } from "./recovery.ts";
import { classifyWriteOutcome, type PlugReading, type WriteResult } from "./plug.ts";
import type { PlugReader, PlugWriter } from "./cycle-plug.ts";
import type { CycleClock } from "./cycle-clock.ts";
import { runWrongBoxGuard, type WrongBoxGuardResult, type WrongBoxIdentityProbe } from "./cycle-wrong-box.ts";
import { evaluatePreconditions, type PreconditionsClearedWitness, type PreconditionsResult } from "./cycle-preconditions.ts";
import {
  decideGate,
  type CycleOutcome,
  type CycleResult,
  type OffAttemptEvidence,
  type ReadBackAttemptEvidence,
  type RestoreAttemptEvidence,
  type RestoreEvidence,
} from "./cycle.ts";
import type { CycleTimingConfig } from "./cycle-config.ts";
import type { WedgeResult } from "./wedge.ts";

export interface CycleRunnerDeps {
  readonly gateConfig: WedgeConfig;
  readonly gateProbes: WedgeProbes;
  readonly configuredTargetHost: string | undefined;
  readonly identityProbe: WrongBoxIdentityProbe;
  readonly recoveryConfig: RecoveryConfig;
  readonly recoveryWedgeProbes: WedgeProbes;
  readonly recoveryProbes: RecoveryProbes;
  /** REQUIRED — no default anywhere in this module (R9). */
  readonly clock: CycleClock;
  readonly timing: CycleTimingConfig;
  readonly forced: boolean;
  /** The exact, operator-configured hand-restore command — see
   * src/cycle-config.ts's own comment. Never a fleet fact this module
   * invents. */
  readonly handRestoreCommand: string | undefined;
}

interface Preamble {
  readonly gate: WedgeResult;
  readonly wrongBoxGuard: WrongBoxGuardResult;
  readonly preconditions: PreconditionsResult;
  readonly reasons: string[];
  readonly proceeds: boolean;
  readonly refusalOutcome: CycleOutcome | null;
}

/**
 * Gate -> wrong-box guard -> preconditions, in that order (R4), each
 * evaluated unconditionally — see this module's own top comment for why
 * none of the three short-circuits the others, and for the refusal-
 * priority rule applied at the end here.
 */
async function runPreamble(
  plug: PlugReader,
  deps: Pick<CycleRunnerDeps, "gateConfig" | "gateProbes" | "configuredTargetHost" | "identityProbe" | "clock" | "forced">,
): Promise<Preamble> {
  const reasons: string[] = [];

  const gate = await runWedgeCheck({ config: deps.gateConfig, probes: deps.gateProbes, now: deps.clock.now() });
  reasons.push(...gate.reasons);

  const wrongBoxGuard = await runWrongBoxGuard(deps.configuredTargetHost, deps.identityProbe);
  reasons.push(...wrongBoxGuard.reasons);

  const preconditions = await evaluatePreconditions(plug);
  reasons.push(...preconditions.reasons);

  const gateDecision = decideGate(gate, deps.forced);
  reasons.push(gateDecision.reason);

  let refusalOutcome: CycleOutcome | null = null;
  if (wrongBoxGuard.outcome !== "not_target") {
    refusalOutcome = "refused_by_wrong_box_guard";
  } else if (preconditions.outcome !== "cleared") {
    refusalOutcome = "refused_by_precondition";
  } else if (!gateDecision.proceeds) {
    refusalOutcome = "refused_by_gate";
  }

  return { gate, wrongBoxGuard, preconditions, reasons, proceeds: refusalOutcome === null, refusalOutcome };
}

function toPreconditionsEvidence(p: PreconditionsResult): CycleResult["preconditions"] {
  return { outcome: p.outcome, reading: p.reading };
}

function buildRefusedResult(preamble: Preamble, dryRun: boolean, forced: boolean): CycleResult {
  return {
    outcome: preamble.refusalOutcome!,
    dryRun,
    forced,
    reasons: preamble.reasons,
    gate: preamble.gate,
    wrongBoxGuard: preamble.wrongBoxGuard,
    preconditions: toPreconditionsEvidence(preamble.preconditions),
    off: null,
    restore: null,
    recovery: null,
    offInstant: null,
    handRestoreCommand: null,
  };
}

/** Reads once, never throwing: a read-back failure is folded into an
 * "unknown" reading with a fragment-safe note, the same treatment
 * src/cli-plug.ts's runPlugWrite() already gives a failed post-write
 * read-back — reused reasoning, not reinvented. */
async function readOnce(plug: PlugReader): Promise<PlugReading> {
  try {
    return await plug.readState();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { power: "unknown", reachable: null, note: `the read-back itself failed: ${detail}` };
  }
}

/**
 * R3: "a contradicted or unpropagated read-back is retried to a configured
 * bound before any conclusion." Retries READS ONLY — `plug` here is typed
 * `PlugReader`, so this function cannot write even when the caller actually
 * holds a `PlugWriter` (structural subtyping lets a PlugWriter be PASSED as
 * a PlugReader; it does not let THIS function's own body see writePower()).
 * Stops early the moment a read-back CONFIRMS the requested state; otherwise
 * keeps retrying until `boundMs` has elapsed since this call started, then
 * returns the LAST classification observed — propagation is never assumed
 * to have finished just because the bound ran out, only reported as
 * whatever was last seen (R3: "propagation was measured exactly once ...
 * that is not a latency budget" — this bound is a circuit-breaker, not a
 * claim about how long propagation actually takes).
 */
async function readBackWithRetry(
  requested: "on" | "off",
  plug: PlugReader,
  clock: CycleClock,
  pollIntervalMs: number,
  boundMs: number,
): Promise<{ attempts: ReadBackAttemptEvidence[]; final: WriteResult }> {
  const attempts: ReadBackAttemptEvidence[] = [];
  const startedAt = clock.now();
  // Sequential by necessity, not oversight: each read-back must be
  // classified, and the bound checked against the clock, before deciding
  // whether to sleep and read again — there is nothing here to parallelize,
  // since attempt N+1 only happens at all when attempt N did not confirm.
  for (let attemptNum = 1; ; attemptNum++) {
    // oxlint-disable-next-line no-await-in-loop
    const reading = await readOnce(plug);
    const result = classifyWriteOutcome(requested, reading);
    attempts.push({ attempt: attemptNum, atMs: clock.now(), result, reading });
    if (result === "confirmed") return { attempts, final: result };
    const elapsed = clock.now() - startedAt;
    if (elapsed >= boundMs) return { attempts, final: result };
    // oxlint-disable-next-line no-await-in-loop
    await clock.sleep(pollIntervalMs);
  }
}

/**
 * The OFF step. R1: exactly ONE `set_property` OFF attempt, on every path
 * — the try/catch below makes that literal: whether the write call itself
 * throws, succeeds-and-reads-back-confirmed, -contradicted, or
 * -unconfirmed, this function calls `plug.writePower("0")` exactly once and
 * never again. The `witness` parameter is never read — see
 * src/cycle-preconditions.ts's own comment: its entire job is to make this
 * function uncallable without a "cleared" PreconditionsResult, a
 * compile-time property, not a runtime check this body performs.
 *
 * WHY AT MOST ONCE — TWO REASONS, AND THE SECOND IS THE IMPORTANT ONE
 * (R1, per the epic's ratification): (i) a contradicted or unreadable
 * read-back is equally consistent with a write that WORKED, so a second
 * blind OFF would act on a plug that may already have switched —
 * redundant. (ii) FAR WORSE THAN REDUNDANT: if the plug DID switch and the
 * box has begun to boot, a SECOND OFF cuts power to a machine MID-BOOT —
 * an unclean power loss during startup, on the box carrying the whole
 * fleet. So the OFF/ON retry asymmetry is not "one is redundant and one is
 * necessary"; it is that a retried OFF has a failure mode the FIRST OFF
 * does not have at all. Do not "fix" this asymmetry into a symmetric
 * retry policy — that reintroduces the mid-boot hazard this function
 * exists to avoid.
 *
 * A THROWN `writePower("0")` IS NOT "NOTHING HAPPENED": a thrown
 * `set_property` call cannot be distinguished from a write that LANDED at
 * Wyze with a lost response (the request reached the device, the
 * acknowledgement did not reach this process) — so a throw here is treated
 * exactly like a contradicted/unconfirmed read-back for R2's purposes:
 * the restore always runs next (see runCycleLive() below), never skipped
 * on the theory that "the write failed, so there is nothing to restore."
 */
export async function performOff(
  plug: PlugWriter,
  witness: PreconditionsClearedWitness,
  clock: CycleClock,
  timing: CycleTimingConfig,
): Promise<OffAttemptEvidence> {
  void witness; // present only to make this call site require one — see this function's own comment.
  let writeThrew = false;
  let writeErrorMessage: string | null = null;
  try {
    await plug.writePower("0");
  } catch (cause) {
    writeThrew = true;
    writeErrorMessage = cause instanceof Error ? cause.message : String(cause);
  }

  // R2: the restore always runs after this point, regardless of what the
  // read-back below concludes — this function does not decide that; its
  // caller (runCycleLive() below) proceeds to wait+restore unconditionally
  // once this function returns, whatever `finalResult` says.
  const { attempts, final } = await readBackWithRetry(
    "off",
    plug,
    clock,
    timing.offReadbackPollIntervalMs,
    timing.offReadbackBoundMs,
  );
  return {
    writeThrew,
    writeErrorMessage,
    readBacks: attempts,
    finalResult: final,
  };
}

/**
 * The never-give-up ON restore (D1). Bounded by `timing.restoreTimeoutMs`,
 * measured entirely on the injected `clock` — R1's "the ON may be retried"
 * means a FRESH `writePower("1")` call every attempt (unlike the OFF step,
 * which writes once), each followed by its own bounded read-back retry
 * (R3). Stops the instant a read-back confirms "on"; otherwise keeps
 * issuing new ON attempts, spaced by `timing.restorePollIntervalMs`, until
 * the outer bound elapses — at which point the caller reports STRANDED.
 */
export async function performRestoreNeverGiveUp(plug: PlugWriter, clock: CycleClock, timing: CycleTimingConfig): Promise<RestoreEvidence> {
  const attempts: RestoreAttemptEvidence[] = [];
  const startedAt = clock.now();

  // Sequential by necessity: each attempt's own bound depends on how much
  // of the outer budget prior attempts already spent (via the clock), and
  // whether there IS a next attempt depends on whether this one confirmed.
  for (let attemptNum = 1; ; attemptNum++) {
    let writeThrew = false;
    let writeErrorMessage: string | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop
      await plug.writePower("1");
    } catch (cause) {
      writeThrew = true;
      writeErrorMessage = cause instanceof Error ? cause.message : String(cause);
    }

    const elapsedBeforeReadback = clock.now() - startedAt;
    const remaining = Math.max(0, timing.restoreTimeoutMs - elapsedBeforeReadback);
    const readBoundThisAttempt = Math.min(timing.restoreReadbackBoundMs, remaining);
    // oxlint-disable-next-line no-await-in-loop
    const { attempts: readBacks, final } = await readBackWithRetry(
      "on",
      plug,
      clock,
      timing.restoreReadbackPollIntervalMs,
      readBoundThisAttempt,
    );
    attempts.push({
      attempt: attemptNum,
      atMs: clock.now(),
      writeThrew,
      writeErrorMessage,
      readBacks,
      finalResult: final,
    });

    if (final === "confirmed") {
      return { attempts, confirmed: true, elapsedMs: clock.now() - startedAt };
    }

    const elapsed = clock.now() - startedAt;
    if (elapsed >= timing.restoreTimeoutMs) {
      return { attempts, confirmed: false, elapsedMs: elapsed };
    }
    // oxlint-disable-next-line no-await-in-loop
    await clock.sleep(timing.restorePollIntervalMs);
  }
}

export function describeOff(off: OffAttemptEvidence): string {
  const writeNote = off.writeThrew ? ` (the write call itself threw: ${off.writeErrorMessage})` : "";
  return (
    `OFF: exactly one set_property attempt made${writeNote} — read-back after ${off.readBacks.length} attempt(s): ` +
    `${off.finalResult}. A contradicted or unconfirmed OFF read-back is NOT treated as "the write failed"; the ` +
    "restore always runs next regardless (R1/R2)."
  );
}

export function describeRestore(restore: RestoreEvidence): string {
  return (
    `RESTORE: ${restore.attempts.length} ON write attempt(s) over ${restore.elapsedMs}ms — ` +
    `${restore.confirmed ? "CONFIRMED on" : "NEVER confirmed on within the configured bound"}.`
  );
}

function mapRecoveryVerdictToCycleOutcome(verdict: RecoveryVerdict): CycleOutcome {
  switch (verdict) {
    case RecoveryVerdict.Recovered:
      return "recovered";
    case RecoveryVerdict.NotRecovered:
      return "not_recovered";
    case RecoveryVerdict.FleetHalfRestored:
      return "fleet_half_restored";
    case RecoveryVerdict.Inconclusive:
      return "recovery_inconclusive";
    case RecoveryVerdict.Unconfigured:
      return "recovery_unconfigured";
  }
}

/**
 * `wyzr cycle --dry-run`. Accepts only a `PlugReader` — see this module's
 * top comment for why that alone is what makes a write structurally
 * unreachable from this function, on every path, including a forced dry
 * run (R5, D7). Runs the FULL preamble (gate, wrong-box guard,
 * preconditions) exactly like the live path and reports either the same
 * refusal a live run would report, or `"would_act"` when every check
 * cleared — see src/errors.ts's ExitCode.CycleDryRunWouldAct for why that
 * is a distinct code from the three refusals.
 */
export async function runCycleDryRun(plug: PlugReader, deps: CycleRunnerDeps): Promise<CycleResult> {
  const preamble = await runPreamble(plug, deps);
  if (!preamble.proceeds) {
    return buildRefusedResult(preamble, true, deps.forced);
  }
  preamble.reasons.push(
    "dry-run: every check cleared — a live run at this moment would proceed to cut power (would_act). No write " +
      "was possible on this path: runCycleDryRun() was handed only a PlugReader.",
  );
  return {
    outcome: "would_act",
    dryRun: true,
    forced: deps.forced,
    reasons: preamble.reasons,
    gate: preamble.gate,
    wrongBoxGuard: preamble.wrongBoxGuard,
    preconditions: toPreconditionsEvidence(preamble.preconditions),
    off: null,
    restore: null,
    recovery: null,
    offInstant: null,
    handRestoreCommand: null,
  };
}

/**
 * `wyzr cycle` (live). Accepts a `PlugWriter`. Runs the same preamble as
 * runCycleDryRun(); if it refuses, returns the matching refusal outcome
 * with NO write ever attempted (same as the dry-run path — the preamble
 * itself only ever touches `PlugReader.readState()`). Once cleared,
 * proceeds through OFF -> wait -> the never-give-up ON restore -> (only if
 * the restore is confirmed) the composed recovery verdict — see this
 * module's top comment for the full sequence and D6/D1's own reasoning for
 * why a confirmed plug alone is never reported as success.
 */
export async function runCycleLive(plug: PlugWriter, deps: CycleRunnerDeps): Promise<CycleResult> {
  const preamble = await runPreamble(plug, deps);
  if (!preamble.proceeds) {
    return buildRefusedResult(preamble, false, deps.forced);
  }
  // preamble.proceeds === true implies preconditions.outcome === "cleared",
  // which is the only branch of evaluatePreconditions() that returns a
  // non-null witness (src/cycle-preconditions.ts) — this `!` is therefore
  // total over every path that reaches here, not an unchecked assumption.
  const witness = preamble.preconditions.witness!;

  const offInstant = deps.clock.now();
  const off = await performOff(plug, witness, deps.clock, deps.timing);
  preamble.reasons.push(describeOff(off));

  preamble.reasons.push(`wait: pausing ${deps.timing.offToOnWaitMs}ms before starting the restore`);
  await deps.clock.sleep(deps.timing.offToOnWaitMs);

  const restore = await performRestoreNeverGiveUp(plug, deps.clock, deps.timing);
  preamble.reasons.push(describeRestore(restore));

  if (!restore.confirmed) {
    const command = deps.handRestoreCommand ?? '(no hand-restore command configured — set "cycle.handRestoreCommand" in config.json)';
    preamble.reasons.push(
      `STRANDED: power is OFF. The restore was NOT confirmed within ${deps.timing.restoreTimeoutMs}ms. ` +
        `Restore it by hand: ${command}`,
    );
    return {
      outcome: "stranded",
      dryRun: false,
      forced: deps.forced,
      reasons: preamble.reasons,
      gate: preamble.gate,
      wrongBoxGuard: preamble.wrongBoxGuard,
      preconditions: toPreconditionsEvidence(preamble.preconditions),
      off,
      restore,
      recovery: null,
      offInstant,
      handRestoreCommand: command,
    };
  }

  // D6: "a cycle that ends without a recovery verdict is not a completed
  // cycle" — the plug confirming "on" is NEVER, on its own, reported as
  // success; runRecoveryCheck() (src/recovery-runner.ts, unchanged) is
  // always called next, `since` set to the OFF instant captured above.
  const recovery = await runRecoveryCheck({
    config: deps.recoveryConfig,
    wedgeProbes: deps.recoveryWedgeProbes,
    recoveryProbes: deps.recoveryProbes,
    since: offInstant,
    now: deps.clock.now(),
  });
  preamble.reasons.push(...recovery.reasons);

  return {
    outcome: mapRecoveryVerdictToCycleOutcome(recovery.verdict),
    dryRun: false,
    forced: deps.forced,
    reasons: preamble.reasons,
    gate: preamble.gate,
    wrongBoxGuard: preamble.wrongBoxGuard,
    preconditions: toPreconditionsEvidence(preamble.preconditions),
    off,
    restore,
    recovery,
    offInstant,
    handRestoreCommand: null,
  };
}
