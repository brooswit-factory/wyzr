// The pure decision core for `wyzr doctor` (WYZR-29): "is this install
// actually able to pull the lever?" Zero I/O — src/doctor-runner.ts gathers
// every observation below (config, credentials, a login attempt, the two
// configured plugs, the outside instruments, the wrong-box guard) through
// real or fake boundaries and hands the already-decided per-check outcomes
// to `evaluateDoctorVerdict()` here, the same pure-engine/impure-runner
// split as src/wedge.ts/src/wedge-runner.ts and src/recovery.ts/
// src/recovery-runner.ts.
//
// REUSES src/recovery.ts's own `CheckOutcome` vocabulary
// (`"pass" | "fail" | "could-not-look" | "not-configured"`) rather than
// inventing a fifth taxonomy for the same four ideas — the ticket's own
// "compose, don't re-invent" instruction, applied to a type this repo
// already established and already tests four-way precedence for.
//
// THE PROPAGATION RULE THIS MODULE'S CALLER (src/doctor-runner.ts) FOLLOWS,
// stated here because it is what makes "not-configured" and "could-not-look"
// stay honestly distinct all the way to the top-level verdict, not just at
// the leaf checks: a check blocked ONLY because an earlier prerequisite was
// itself never configured (no config.json at all, no credentials.json at
// all) reports itself "not-configured" too — "nobody told me where to look"
// propagates as itself, it does not turn into "I looked and could not see."
// A check blocked because an earlier prerequisite was attempted and BROKE
// (a malformed config file, unreadable credentials) reports itself
// "could-not-look" — that is a real, existing problem blocking this check,
// not an unconfigured gap. Only a check that had everything it needed and
// still could not get a clean answer (a DNS lookup failure, an undecodable
// plug reading, an instrument timeout) is "could-not-look" for its OWN
// reason rather than by inheritance. See the PR body for why this ticket's
// own honesty split (rule 1: "could not look is neither pass nor fail")
// pushed this design past what src/recovery.ts needed — every one of
// recovery's five checks is independently read over the network with no
// shared prerequisite chain; the doctor's checks genuinely nest (no
// credentials -> cannot attempt login -> cannot read a plug), so this
// module's caller has a real distinction to make that recovery-runner.ts
// never had to.

import type { CheckOutcome } from "./recovery.ts";
import type { WrongBoxGuardOutcome } from "./cycle-wrong-box.ts";

export const DoctorVerdict = {
  Ready: "READY",
  NotReady: "NOT_READY",
  Inconclusive: "INCONCLUSIVE",
  Unconfigured: "UNCONFIGURED",
} as const;
export type DoctorVerdict = (typeof DoctorVerdict)[keyof typeof DoctorVerdict];

/** One target plug's two independently-decided facts — see the ticket's
 * "the target plugs: resolvable and readable" bullet, kept as two separate
 * outcomes rather than collapsed into one, since a plug can be resolvable
 * but unreadable (a stale reading) or, in principle, readable while this
 * repo's own device-list cross-check missed it (paginated/stale device
 * list) — collapsing them would hide exactly that kind of disagreement. */
export interface DoctorPlugCheck {
  readonly label: "fleetPlug" | "safePlug";
  /** Identifiers only — mac/model/name are legible diagnostics an operator
   * reads on their own screen (the epic's own address-disclosure ruling,
   * extended the same way to plug identity: "FINE WHERE IT IS READ" — see
   * src/config.ts's own top comment). Never a secret. `null` only when
   * config itself never loaded, so this command never even learned this
   * plug's configured identity. */
  readonly mac: string | null;
  readonly model: string | null;
  readonly name: string | null;
  readonly resolvable: CheckOutcome;
  readonly resolvableNote: string | null;
  readonly readable: CheckOutcome;
  readonly readableNote: string | null;
}

export interface DoctorInstrumentCheck {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly note: string | null;
}

export interface DoctorWrongBoxCheck {
  readonly outcome: WrongBoxGuardOutcome;
  readonly reasons: readonly string[];
}

export interface DoctorConfigCheck {
  readonly outcome: CheckOutcome;
  readonly note: string | null;
  /** Which optional sections were present in the loaded config — name to
   * boolean presence ONLY, never a value. Empty when `outcome !== "pass"`
   * (there is nothing to report section-by-section without a loaded
   * config). */
  readonly optionalSections: Readonly<Record<string, boolean>>;
}

export interface DoctorCredentialsCheck {
  readonly outcome: CheckOutcome;
  readonly note: string | null;
}

export interface DoctorCloudCheck {
  readonly outcome: CheckOutcome;
  readonly note: string | null;
}

export interface DoctorInput {
  readonly config: DoctorConfigCheck;
  readonly credentials: DoctorCredentialsCheck;
  readonly cloud: DoctorCloudCheck;
  readonly fleetPlug: DoctorPlugCheck;
  readonly safePlug: DoctorPlugCheck;
  readonly instruments: readonly DoctorInstrumentCheck[];
  readonly wrongBoxGuard: DoctorWrongBoxCheck;
  /** Whether the wrong-box guard's own "inconclusive" outcome (if any) is
   * itself a "not-configured" state (no target host was available to even
   * hand the guard — config never loaded) rather than a genuine
   * "could-not-look" (a real target host was configured and DNS/hosts-file
   * resolution, or local-address enumeration, still failed). Computed by
   * the caller, which knows WHY it called the guard the way it did — not a
   * re-interpretation of the guard's own reason text. */
  readonly wrongBoxGuardBlockedByMissingConfig: boolean;
  /** Prose describing what this run's own read primitives stand on and
   * what they do not — the ticket's "what remains unproven" row. Static,
   * not data-dependent: see src/doctor-runner.ts's UNPROVEN_NOTES. */
  readonly unproven: readonly string[];
}

export interface DoctorChecks {
  readonly config: CheckOutcome;
  readonly credentials: CheckOutcome;
  readonly cloud: CheckOutcome;
  readonly fleetPlugResolvable: CheckOutcome;
  readonly fleetPlugReadable: CheckOutcome;
  readonly safePlugResolvable: CheckOutcome;
  readonly safePlugReadable: CheckOutcome;
  readonly instruments: readonly CheckOutcome[];
  readonly wrongBoxGuard: CheckOutcome;
}

export interface DoctorResult extends DoctorInput {
  readonly verdict: DoctorVerdict;
  readonly reasons: readonly string[];
  readonly checks: DoctorChecks;
}

/**
 * The propagation rule this file's top comment describes, made concrete:
 * how a check that is structurally blocked by an unavailable PREREQUISITE
 * (not by its own, independent attempt) should report itself. A
 * `"not-configured"` prerequisite propagates as itself — nobody has set
 * this up yet, so nothing downstream of it was ever attempted either. A
 * `"fail"` or an already-propagated `"could-not-look"` prerequisite
 * propagates as `"could-not-look"` — a real, existing problem is blocking
 * this check, which is a different fact from "nobody configured it." Never
 * called with a `"pass"` prerequisite — that means the check should
 * actually attempt its own read, not report a blocked status at all.
 */
export function blockedByPrerequisite(prerequisite: CheckOutcome): CheckOutcome {
  return prerequisite === "not-configured" ? "not-configured" : "could-not-look";
}

/** Maps the wrong-box guard's own three-way outcome onto the shared
 * `CheckOutcome` vocabulary for verdict-aggregation purposes ONLY — the
 * guard's raw outcome and reasons are still reported verbatim elsewhere in
 * `DoctorResult` (`wrongBoxGuard.outcome`/`.reasons`), never overwritten.
 * `is_target` maps to `"fail"`: a doctor run that discovers it is running
 * ON the fleet box itself is discovering the single most consequential
 * fact this command can report, and burying it inside a generically-worded
 * "could not look" would be exactly the kind of understatement rule 7 of
 * the ticket's honesty split forbids. `inconclusive` maps to
 * `"not-configured"` when the caller determiened the guard never had a
 * real target to check (config never loaded) — see
 * `DoctorInput.wrongBoxGuardBlockedByMissingConfig` — and to
 * `"could-not-look"` otherwise (a real target was configured and
 * resolution still failed). This is the one place this module reads a
 * caller-supplied fact about WHY a check ran the way it did, rather than
 * re-deriving it from the guard's own reason text — see this file's top
 * comment for why that distinction is the caller's to make, not a
 * re-interpretation of what the guard decided. */
function wrongBoxGuardCheckOutcome(input: DoctorInput): CheckOutcome {
  switch (input.wrongBoxGuard.outcome) {
    case "not_target":
      return "pass";
    case "is_target":
      return "fail";
    case "inconclusive":
      return input.wrongBoxGuardBlockedByMissingConfig ? "not-configured" : "could-not-look";
  }
}

/**
 * THE PURE DECISION CORE. Precedence mirrors src/recovery.ts's
 * `evaluateRecovery()` exactly (rules 2-5 there; this command has no
 * FLEET_HALF_RESTORED analogue, so rule 1 does not apply here):
 *
 * 1. NOT_READY whenever ANY check affirmatively failed — "an affirmative
 *    failure outranks an absence."
 * 2. INCONCLUSIVE when nothing failed but at least one check that WAS
 *    attempted could not be read — "a could-not-look outranks an
 *    unconfigured gap."
 * 3. UNCONFIGURED when nothing failed and nothing was unreadable, and the
 *    only gaps are checks nobody ever pointed anywhere (no config at all,
 *    no credentials at all, or an optional section never supplied).
 * 4. READY only when every check that could run affirmatively passed.
 *
 * Never upgrades "could-not-look" or "not-configured" to a pass, and never
 * downgrades either to a fail — only an actual per-check "fail" reaches
 * rule 1, and only "pass" everywhere reaches rule 4 (same invariant
 * src/recovery.ts's own precedence comment states and tests).
 */
export function evaluateDoctorVerdict(input: DoctorInput): DoctorResult {
  const wrongBoxGuard = wrongBoxGuardCheckOutcome(input);

  const checks: DoctorChecks = {
    config: input.config.outcome,
    credentials: input.credentials.outcome,
    cloud: input.cloud.outcome,
    fleetPlugResolvable: input.fleetPlug.resolvable,
    fleetPlugReadable: input.fleetPlug.readable,
    safePlugResolvable: input.safePlug.resolvable,
    safePlugReadable: input.safePlug.readable,
    instruments: input.instruments.map((i) => i.outcome),
    wrongBoxGuard,
  };

  const outcomes: CheckOutcome[] = [
    checks.config,
    checks.credentials,
    checks.cloud,
    checks.fleetPlugResolvable,
    checks.fleetPlugReadable,
    checks.safePlugResolvable,
    checks.safePlugReadable,
    ...checks.instruments,
    checks.wrongBoxGuard,
  ];

  const reasons: string[] = [
    `config: ${checks.config}${input.config.note ? ` — ${input.config.note}` : ""}`,
    `credentials: ${checks.credentials}${input.credentials.note ? ` — ${input.credentials.note}` : ""}`,
    `cloud (login attempt): ${checks.cloud}${input.cloud.note ? ` — ${input.cloud.note}` : ""}`,
    `fleetPlug resolvable: ${checks.fleetPlugResolvable}${input.fleetPlug.resolvableNote ? ` — ${input.fleetPlug.resolvableNote}` : ""}`,
    `fleetPlug readable: ${checks.fleetPlugReadable}${input.fleetPlug.readableNote ? ` — ${input.fleetPlug.readableNote}` : ""}`,
    `safePlug resolvable: ${checks.safePlugResolvable}${input.safePlug.resolvableNote ? ` — ${input.safePlug.resolvableNote}` : ""}`,
    `safePlug readable: ${checks.safePlugReadable}${input.safePlug.readableNote ? ` — ${input.safePlug.readableNote}` : ""}`,
    ...input.instruments.map((i) => `instrument "${i.name}": ${i.outcome}${i.note ? ` — ${i.note}` : ""}`),
    `wrong-box guard: ${input.wrongBoxGuard.outcome} — ${input.wrongBoxGuard.reasons.join("; ")}`,
  ];

  const outcomeSet = new Set(outcomes);

  let verdict: DoctorVerdict;
  if (outcomeSet.has("fail")) {
    verdict = DoctorVerdict.NotReady;
    reasons.push("VERDICT: NOT_READY — at least one check affirmatively failed");
  } else if (outcomeSet.has("could-not-look")) {
    verdict = DoctorVerdict.Inconclusive;
    reasons.push("VERDICT: INCONCLUSIVE — nothing affirmatively failed, but at least one attempted check could not be read");
  } else if (outcomeSet.has("not-configured")) {
    verdict = DoctorVerdict.Unconfigured;
    reasons.push("VERDICT: UNCONFIGURED — nothing failed and nothing was unreadable; the only gaps are checks never pointed anywhere");
  } else {
    verdict = DoctorVerdict.Ready;
    reasons.push("VERDICT: READY — every check this doctor could run affirmatively passed");
  }

  return { ...input, verdict, reasons, checks };
}
