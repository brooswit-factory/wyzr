// `wyzr cycle`'s own types and the one genuinely PURE decision this verb
// makes on its own: whether the gate's verdict (src/wedge.ts, composed
// never reimplemented) lets the run proceed, given whether it was
// human-forced (D4/D5). Every OTHER decision this verb makes is either
// delegated whole to an existing engine (src/wedge.ts's evaluateWedge(),
// src/recovery.ts's evaluateRecovery()) or is inherently I/O-shaped (the
// wrong-box guard's hostname read, the preconditions' plug read, the OFF/
// wait/ON sequence) and lives in src/cycle-runner.ts instead — see that
// module's own comment for why `wyzr cycle` does not force a single
// pure-engine/impure-runner split the way src/wedge.ts + src/wedge-runner.ts
// does: this verb's "engine" is a multi-step PROCEDURE with real actions at
// specific points, not a single evaluate(input) -> verdict function, and
// bending it into that shape would hide exactly the sequencing (D1's
// asymmetry, R1's at-most-once OFF, R2's always-attempt-restore) the ticket
// requires to be explicit and orderly, not implicit in how a bigger pure
// function's branches happen to be arranged.

import { WedgeVerdict, type WedgeResult } from "./wedge.ts";
import type { RecoveryResult } from "./recovery.ts";
import type { PlugReading, WriteResult } from "./plug.ts";
import type { WrongBoxGuardResult } from "./cycle-wrong-box.ts";
import type { PreconditionsOutcome } from "./cycle-preconditions.ts";

/**
 * Every terminal classification `wyzr cycle` can report. Deliberately ONE
 * flat union covering both refusals and post-cycle outcomes — src/cli-cycle.ts's
 * exit-code mapper switches on this VALUE (never reconstructs one from
 * formatted text), the same discipline this codebase already requires for
 * WedgeVerdict/RecoveryVerdict.
 *
 * "would_act" is DRY-RUN ONLY — see src/errors.ts's ExitCode.CycleDryRunWouldAct
 * comment for why a dry run that instead refuses reuses the three refusal
 * values below rather than getting its own three "dry-run refused" values.
 */
export type CycleOutcome =
  | "refused_by_wrong_box_guard"
  | "refused_by_precondition"
  | "refused_by_gate"
  | "would_act"
  | "stranded"
  | "recovered"
  | "not_recovered"
  | "fleet_half_restored"
  | "recovery_inconclusive"
  | "recovery_unconfigured";

export interface ReadBackAttemptEvidence {
  readonly attempt: number;
  readonly atMs: number;
  readonly result: WriteResult;
  readonly reading: PlugReading;
}

export interface OffAttemptEvidence {
  readonly writeThrew: boolean;
  readonly writeErrorMessage: string | null;
  readonly readBacks: readonly ReadBackAttemptEvidence[];
  /** `src/cycle-runner.ts`'s `readBackWithRetry()` always performs at
   * least one read before it can return (its loop pushes an attempt
   * before any `return` statement), so `readBacks` is never empty here —
   * this is always a REAL classification, never a placeholder for "no
   * read happened." (Caught by review, 2026-09-11: an earlier version of
   * this field admitted a `"never_read"` sentinel for a branch that was
   * provably unreachable by that same construction — dead code removed
   * rather than left to imply a case that could not occur.) */
  readonly finalResult: WriteResult;
}

export interface RestoreAttemptEvidence {
  readonly attempt: number;
  readonly atMs: number;
  readonly writeThrew: boolean;
  readonly writeErrorMessage: string | null;
  readonly readBacks: readonly ReadBackAttemptEvidence[];
  /** Same guarantee as `OffAttemptEvidence.finalResult` above — always a
   * real classification. */
  readonly finalResult: WriteResult;
}

export interface RestoreEvidence {
  readonly attempts: readonly RestoreAttemptEvidence[];
  readonly confirmed: boolean;
  readonly elapsedMs: number;
}

export interface PreconditionsEvidence {
  readonly outcome: PreconditionsOutcome;
  readonly reading: PlugReading | null;
}

/** The full evidence trail plus verdict — "the evidence is the product,
 * the verdict is a summary of it" (R4), same discipline as
 * `WedgeResult`/`RecoveryResult`. Every step's own raw result is preserved
 * (`gate`/`wrongBoxGuard`/`preconditions`/`off`/`restore`/`recovery`), not
 * collapsed into a boolean anywhere. */
export interface CycleResult {
  readonly outcome: CycleOutcome;
  readonly dryRun: boolean;
  readonly forced: boolean;
  /** The ordered evidence trail, in the order R4 decides it: gate, then
   * wrong-box guard, then preconditions, then (live only) OFF, wait, ON,
   * recovery. */
  readonly reasons: readonly string[];
  readonly gate: WedgeResult;
  readonly wrongBoxGuard: WrongBoxGuardResult;
  readonly preconditions: PreconditionsEvidence;
  readonly off: OffAttemptEvidence | null;
  readonly restore: RestoreEvidence | null;
  readonly recovery: RecoveryResult | null;
  /** Epoch ms the OFF was attempted — `null` on every refused/would_act
   * outcome (no OFF was ever attempted), non-null on `stranded` and every
   * recovery-verdict outcome. This is the SAME instant passed to
   * src/recovery-runner.ts's `since` — exposed here so src/cli-cycle.ts can
   * render `recovery` through src/cli-recovery.ts's own
   * `toRecoveryStatusJson()`/`formatRecoveryStatusHuman()`, which both need
   * `since` as a value distinct from `RecoveryResult` itself. */
  readonly offInstant: number | null;
  /** Populated only for `outcome === "stranded"` — the exact, operator-
   * configured single command that restores power by hand (D1: "this is
   * the loudest thing in the product"). */
  readonly handRestoreCommand: string | null;
}

export interface GateDecision {
  readonly proceeds: boolean;
  readonly reason: string;
}

/**
 * The one genuinely pure decision this verb makes for itself: given the
 * gate's already-computed verdict and whether the run was human-forced,
 * does the run proceed past the gate? Switches on `gate.verdict`'s VALUE
 * (never reconstructs it from `gate.reasons`' prose) — D3/D5/D4 encoded
 * directly:
 * - PROVEN: proceed, unconditionally, no extra ceremony (D5 — "ceremony in
 *   the one case the product exists for is a design failure").
 * - NOT_PROVEN / INCONCLUSIVE_BY_SHARED_CAUSE, forced: proceed — force
 *   overrides the JUDGMENT (D4). It does NOT and cannot override the
 *   wrong-box guard or the preconditions; those are evaluated independently
 *   by src/cycle-runner.ts and can refuse regardless of what this function
 *   returns — see that module's own comment for the refusal-priority order
 *   and why it is not simply "whichever check runs first."
 * - NOT_PROVEN / INCONCLUSIVE_BY_SHARED_CAUSE, not forced: refuse (D3 — the
 *   gate errs tight, default refuse).
 */
export function decideGate(gate: WedgeResult, forced: boolean): GateDecision {
  if (gate.verdict === WedgeVerdict.Proven) {
    return { proceeds: true, reason: "gate: PROVEN — proceeding (D5: no extra ceremony for the case this product exists for)" };
  }
  if (forced) {
    return {
      proceeds: true,
      reason:
        `gate: ${gate.verdict}, but the run was human-forced — force overrides the JUDGMENT (D4); it does not, ` +
        "and structurally cannot, override the wrong-box guard or the preconditions, both of which are evaluated " +
        "regardless of this decision",
    };
  }
  return {
    proceeds: false,
    reason: `gate: ${gate.verdict} and the run was not forced — REFUSING (D3: the gate errs tight, default refuse)`,
  };
}
