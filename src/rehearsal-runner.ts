// `wyzr rehearse-safe-plug-write` (WYZR-20/WYZR-30) — THE FIRST PLUG WRITE
// THIS PRODUCT HAS EVER PERFORMED. `plug on`/`plug off` (and therefore
// `wyzr cycle`, which is built entirely on the same unexercised write
// primitives) have never run through this product, by anyone, ever — see
// README's "wyzr cycle" honesty-split section. This module is the staged
// rehearsal that moves the write path from "never exercised" to "exercised
// by this code, once, on a date a human executor records" — **when a human
// runs it, not when this merges.** No agent ever runs this for real: see
// docs/write-rehearsal-procedure.md.
//
// SAFE-PLUG-ONLY, TWO INDEPENDENT GUARDS, NEITHER OPTIONAL:
//
// 1. COMPILE-TIME: both entry points below accept a `SafePlugTarget`
//    (src/config.ts), never a `FleetPlugTarget` — the two are branded with
//    DIFFERENT module-private `unique symbol` keys, so passing a
//    `FleetPlugTarget` anywhere a `SafePlugTarget` is expected is a
//    compile error, not a runtime check someone can forget. See
//    test/unit/rehearsal-runner.test.ts's `@ts-expect-error` pin,
//    mutation-tested.
// 2. RUNTIME, DEFENSE IN DEPTH: `runPreamble()` below calls
//    `deps.sameDeviceCheck(deps.fleetPlug, deps.safePlug)` — defaulting to
//    `src/config.ts`'s own `samePlugIdentity()`, REUSED not re-derived —
//    and refuses BEFORE any read or write is attempted if it returns true.
//    **This is provably unreachable through the real CLI today**:
//    `loadWyzrConfig()` itself already refuses to construct a `WyzrConfig`
//    whose `fleetPlug`/`safePlug` conflate (`refuseIfPlugsConflate()`,
//    exhaustively tested in test/unit/config.test.ts), so any `WyzrConfig`
//    this command's own CLI wiring (src/cli-rehearsal.ts) holds is already
//    live proof the two plugs differ. Kept anyway, on the EXACT precedent
//    src/cli-cycle.ts's `resolveForced()` sets for its own "unreachable in
//    practice" branch (see that function's own comment) — a second,
//    independent guard beats relying on one upstream check alone for the
//    one operation in this whole product that must never reach the fleet
//    plug. `sameDeviceCheck` is INJECTABLE specifically so this wiring can
//    be tested at all: `FleetPlugTarget`/`SafePlugTarget`'s branding makes
//    it IMPOSSIBLE for any test (short of the `as unknown as` lie
//    src/config.ts's own top comment forbids) to construct a conflated
//    pair through the real loader, so test/unit/rehearsal-runner.test.ts
//    proves this module correctly WIRES a same-device signal to a
//    zero-I/O refusal via an injected fake comparator, deliberately NOT
//    re-testing `samePlugIdentity()`'s own comparison semantics (already
//    exhaustive in test/unit/config.test.ts) — the same "each check proves
//    a different property" split WYZR-29's doctor-no-write trio already
//    established in this repo.
//
// RESTORE IS STRUCTURALLY UNSKIPPABLE — REUSED, NOT RE-DERIVED. R2's
// reasoning in src/cycle-runner.ts ("a thrown set_property cannot be
// distinguished from a write that landed with a lost response, so 'nothing
// happened, exit' is never safe") applies to this verb IDENTICALLY. Rather
// than re-deriving it, this module calls src/cycle-runner.ts's own EXPORTED
// `performOff()`/`performRestoreNeverGiveUp()`/`describeOff()`/
// `describeRestore()` UNCHANGED — see that module's own top comment for why
// these were made reusable. There is exactly ONE at-most-once-OFF/
// never-give-up-ON implementation in this codebase, not two that could
// silently diverge.
//
// TWO ENTRY POINTS, NOT ONE WITH A FLAG — same R5-shaped structural
// guarantee src/cycle-runner.ts established: `runRehearsalPreview()`
// accepts a `PlugReader`; `runRehearsalLive()` accepts a `PlugWriter`. A
// write call anywhere in `runRehearsalPreview()`'s body does not
// typecheck.
//
// NO CLI POSITIONAL ARGUMENT NAMES THE TARGET, EVER — the safe plug is
// ALWAYS `deps.safePlug`, sourced from config. See
// src/cli-rehearsal.ts's own parser: this command accepts no positional
// argument at all, so there is no code path where a query string could be
// threaded through to the plug this module writes to.
//
// NO GATE, NO WRONG-BOX GUARD — deliberately absent, unlike
// src/cycle-runner.ts. The wrong-box guard answers "is THIS MACHINE the
// fleet box" (a host-identity question `wyzr cycle` needs because it can
// legitimately be pointed at the fleet plug); this command can NEVER be
// pointed at the fleet plug at all (see guard 1/2 above), so there is no
// analogous host-identity question to ask. The wedge gate answers "is the
// fleet box definitively gone" — irrelevant to rehearsing a write against
// an unrelated, currently-in-use safe plug.
//
// THE RESIDUAL CASE THIS REASONING LEAVES OPEN (WYZR-30 review finding 1,
// 2026-09-11): "is THIS MACHINE the fleet box" is the wrong question to
// have asked here — the right, adjacent one is "does the SAFE PLUG power
// the box this command is running on?" No code anywhere in this codebase
// can answer that (nothing here can know what a plug powers), so it is
// NOT, and cannot be, a guard. If it is true, the OFF this module attempts
// cuts power to the process running it — the never-give-up restore never
// executes, no outcome is ever returned, and no capture-format evidence is
// produced; the plug is simply off, with no record anything happened.
// This is NOT the same failure class as guard 2 (fleet-plug identity):
// guard 2 is closed, structurally and at runtime; THIS is closed
// PROCEDURALLY, in docs/write-rehearsal-procedure.md's own "before you
// start" section, which requires the executor to confirm the safe plug
// does not power their own machine before ever running the confirmed
// write. Consequently, "no path ends with the plug off" (property 3) is
// proven by this module and test/unit/rehearsal-runner.test.ts's own
// suite ONLY for every failure the process itself SURVIVES — a process
// that dies mid-run is outside what any in-process test can construct,
// and outside what this comment claims to cover.

import type { PlugReader, PlugWriter } from "./cycle-plug.ts";
import type { CycleClock } from "./cycle-clock.ts";
import type { CycleTimingConfig } from "./cycle-config.ts";
import { evaluatePreconditions, type PreconditionsOutcome, type PreconditionsResult } from "./cycle-preconditions.ts";
import { describeOff, describeRestore, performOff, performRestoreNeverGiveUp } from "./cycle-runner.ts";
import type { OffAttemptEvidence, RestoreEvidence } from "./cycle.ts";
import type { PlugReading } from "./plug.ts";
import { samePlugIdentity, type FleetPlugTarget, type SafePlugTarget } from "./config.ts";

/** Injectable so test/unit/rehearsal-runner.test.ts can prove this module's
 * OWN wiring reacts correctly to a same-device signal without needing to
 * construct an impossible conflated (FleetPlugTarget, SafePlugTarget) pair
 * — see this module's own top comment, guard 2. */
export type PlugIdentityCheck = (fleetPlug: FleetPlugTarget, safePlug: SafePlugTarget) => boolean;

export const defaultPlugIdentityCheck: PlugIdentityCheck = samePlugIdentity;

export type RehearsalOutcome =
  | "refused_same_as_fleet_plug"
  | "refused_by_precondition"
  | "would_write"
  | "stranded"
  | "confirmed";

export interface RehearsalPreconditionsEvidence {
  readonly outcome: PreconditionsOutcome | null;
  readonly reading: PlugReading | null;
}

export interface RehearsalSafePlugIdentity {
  readonly mac: string;
  readonly model: string;
  readonly name: string;
  /** `null` when the safe plug target IS the addressable device — see
   * src/config.ts's `PlugTargetFields.subDeviceId` own comment. Carried
   * here (WYZR-30 review finding 2) so src/rehearsal-paste-back.ts can
   * elide it by VALUE on the paste-back path, same as `mac`/`name`. */
  readonly subDeviceId: string | null;
}

/** The full evidence trail plus verdict — same "evidence is the product"
 * discipline as CycleResult/WedgeResult/RecoveryResult. */
export interface RehearsalResult {
  readonly outcome: RehearsalOutcome;
  readonly dryRun: boolean;
  readonly reasons: readonly string[];
  /** `null` only for `refused_same_as_fleet_plug` — that refusal is decided
   * BEFORE any read is attempted (see this module's own top comment). */
  readonly preconditions: RehearsalPreconditionsEvidence;
  readonly off: OffAttemptEvidence | null;
  readonly restore: RestoreEvidence | null;
  /** Epoch ms the OFF was attempted — `null` on every refused/would_write
   * outcome, non-null on `stranded`/`confirmed`. */
  readonly offInstant: number | null;
  /** The configured safe plug's own identity — legible in ordinary output
   * exactly like `wyzr doctor`'s plug rows (identifiers are deliberately
   * NOT redacted at the point they are READ; only the capture-format
   * paste-back path redacts, per src/capture-format.ts's own top comment
   * — see docs/write-rehearsal-procedure.md). */
  readonly safePlugIdentity: RehearsalSafePlugIdentity;
}

export interface RehearsalRunnerDeps {
  readonly fleetPlug: FleetPlugTarget;
  readonly safePlug: SafePlugTarget;
  /** REQUIRED — no default, same R9 discipline as src/cycle-runner.ts's
   * own CycleRunnerDeps.clock: an omitted clock is a compile error, never
   * a fallback to a real timer. */
  readonly clock: CycleClock;
  /** Reused from `config.cycle.timing` (src/cycle-config.ts) — the exact
   * same OFF-wait-ON-never-give-up shape applies identically to a
   * different plug; see src/cli-rehearsal.ts for why this ticket does not
   * introduce a parallel, second timing config surface. */
  readonly timing: CycleTimingConfig;
  readonly sameDeviceCheck: PlugIdentityCheck;
}

function identityOf(plug: SafePlugTarget): RehearsalSafePlugIdentity {
  return { mac: plug.mac, model: plug.model, name: plug.name, subDeviceId: plug.subDeviceId };
}

interface Preamble {
  readonly reasons: string[];
  readonly preconditions: PreconditionsResult | null;
  readonly proceeds: boolean;
  readonly refusalOutcome: RehearsalOutcome | null;
}

/**
 * Guard 2, then the D1-shaped before-the-cut precondition — in that order,
 * and the FIRST one short-circuits the second deliberately: if the
 * same-device check trips, this function returns WITHOUT ever calling
 * `plug.readState()` — see this module's own top comment for why even a
 * READ of a device that might be the fleet plug's own outlet is avoided,
 * not just a write. `evaluatePreconditions()` (src/cycle-preconditions.ts,
 * reused unchanged) is composed exactly as-is: reaching a decodable
 * get_property_list response proves both cloud-reachable and
 * plug-state-known in one call, and its `PreconditionsClearedWitness` is
 * this module's own gate on `performOff()` too — see that type's own
 * comment for why no flag anywhere in this codebase can forge one.
 */
async function runPreamble(plug: PlugReader, deps: RehearsalRunnerDeps): Promise<Preamble> {
  const reasons: string[] = [];

  if (deps.sameDeviceCheck(deps.fleetPlug, deps.safePlug)) {
    reasons.push(
      "REFUSING before any read or write was attempted: the configured safe plug resolves to the SAME device as " +
        "the configured fleet plug (mac/subDeviceId identity — see src/config.ts's samePlugIdentity()). This is a " +
        "second, independent check — src/config.ts's loadWyzrConfig() already refuses to load a config where the " +
        "two conflate, so this path is not reachable through the real CLI today, and is kept anyway as " +
        "defense in depth for the one operation in this product that must never reach the fleet plug.",
    );
    return { reasons, preconditions: null, proceeds: false, refusalOutcome: "refused_same_as_fleet_plug" };
  }

  const preconditions = await evaluatePreconditions(plug);
  reasons.push(...preconditions.reasons);

  if (preconditions.outcome !== "cleared") {
    return { reasons, preconditions, proceeds: false, refusalOutcome: "refused_by_precondition" };
  }

  return { reasons, preconditions, proceeds: true, refusalOutcome: null };
}

function toEvidence(preconditions: PreconditionsResult | null): RehearsalPreconditionsEvidence {
  return { outcome: preconditions?.outcome ?? null, reading: preconditions?.reading ?? null };
}

function buildRefusedResult(preamble: Preamble, dryRun: boolean, deps: RehearsalRunnerDeps): RehearsalResult {
  return {
    outcome: preamble.refusalOutcome!,
    dryRun,
    reasons: preamble.reasons,
    preconditions: toEvidence(preamble.preconditions),
    off: null,
    restore: null,
    offInstant: null,
    safePlugIdentity: identityOf(deps.safePlug),
  };
}

/**
 * The preview path — accepts only a `PlugReader`, so a write call anywhere
 * in this function's body does not typecheck (R5-shaped, same as
 * src/cycle-runner.ts's runCycleDryRun()). Runs the full preamble; if it
 * refuses, reports that refusal; otherwise reports `would_write` — every
 * check cleared, so a CONFIRMED run at this exact moment would proceed to
 * cut power on the configured safe plug.
 */
export async function runRehearsalPreview(plug: PlugReader, deps: RehearsalRunnerDeps): Promise<RehearsalResult> {
  const preamble = await runPreamble(plug, deps);
  if (!preamble.proceeds) {
    return buildRefusedResult(preamble, true, deps);
  }
  preamble.reasons.push(
    "preview: preconditions cleared — a CONFIRMED run at this moment would proceed to cut power on the " +
      "configured safe plug (would_write). No write was possible on this path: runRehearsalPreview() was handed " +
      "only a PlugReader.",
  );
  return {
    outcome: "would_write",
    dryRun: true,
    reasons: preamble.reasons,
    preconditions: toEvidence(preamble.preconditions),
    off: null,
    restore: null,
    offInstant: null,
    safePlugIdentity: identityOf(deps.safePlug),
  };
}

/**
 * The live path — accepts a `PlugWriter`. Runs the same preamble as
 * runRehearsalPreview(); if it refuses, returns the matching refusal with
 * NO write ever attempted. Once cleared, proceeds through OFF -> wait ->
 * the never-give-up ON restore (both REUSED unchanged from
 * src/cycle-runner.ts — see this module's own top comment). **There is no
 * `return` anywhere in this function between the OFF write and the
 * restore having been attempted and its outcome recorded** — see
 * src/cli-rehearsal.ts's PR-body enumeration of every path that reaches a
 * write, per the ticket's own requirement.
 */
export async function runRehearsalLive(plug: PlugWriter, deps: RehearsalRunnerDeps): Promise<RehearsalResult> {
  const preamble = await runPreamble(plug, deps);
  if (!preamble.proceeds) {
    return buildRefusedResult(preamble, false, deps);
  }
  // preamble.proceeds === true implies preconditions.outcome === "cleared",
  // the only branch of evaluatePreconditions() that returns a non-null
  // witness — same totality argument src/cycle-runner.ts's own
  // runCycleLive() makes for the identical `!`.
  const witness = preamble.preconditions!.witness!;

  const offInstant = deps.clock.now();
  const off = await performOff(plug, witness, deps.clock, deps.timing);
  preamble.reasons.push(describeOff(off));

  preamble.reasons.push(`wait: pausing ${deps.timing.offToOnWaitMs}ms before starting the restore`);
  await deps.clock.sleep(deps.timing.offToOnWaitMs);

  const restore = await performRestoreNeverGiveUp(plug, deps.clock, deps.timing);
  preamble.reasons.push(describeRestore(restore));

  if (!restore.confirmed) {
    preamble.reasons.push(
      `STRANDED: power is OFF on the configured safe plug (${deps.safePlug.name}, mac=${deps.safePlug.mac}). The ` +
        `restore was NOT confirmed within ${deps.timing.restoreTimeoutMs}ms. This plug was deliberately chosen ` +
        "because an executor can reach it directly: go to it now and restore power by hand (its physical switch, " +
        "or its normal Wyze app control) — there is no configured remote hand-restore command for the safe plug, " +
        "unlike the fleet plug's own STRANDED message, because the safe plug's whole point is that an executor can " +
        "always reach it without one. Record that you did this, and that this outcome was NOT reported as success.",
    );
    return {
      outcome: "stranded",
      dryRun: false,
      reasons: preamble.reasons,
      preconditions: toEvidence(preamble.preconditions),
      off,
      restore,
      offInstant,
      safePlugIdentity: identityOf(deps.safePlug),
    };
  }

  preamble.reasons.push("CONFIRMED: the safe plug's own read-back confirms it is back ON.");
  return {
    outcome: "confirmed",
    dryRun: false,
    reasons: preamble.reasons,
    preconditions: toEvidence(preamble.preconditions),
    off,
    restore,
    offInstant,
    safePlugIdentity: identityOf(deps.safePlug),
  };
}
