// The wedge-proof engine: a PURE, injectable-boundary library module. It
// takes already-gathered observations IN and produces a verdict plus its
// full evidence trail OUT. It performs NO I/O of any kind — see
// src/wedge-probes.ts for the injectable boundary that gathers the
// observations this module consumes (src/wedge-runner.ts is the orchestrator
// that calls that boundary and hands this module its input), the same split
// this repo already uses for src/transport.ts (interface) vs
// src/auth-session.ts (orchestration) — see that pair's own comments for the
// established pattern this module follows rather than inventing a second one.
//
// PUBLISHED INTERFACE (WYZR-16's "what later stories inherit from your
// shape" — WYZR-19, `wyzr cycle`, calls this engine and is forbidden from
// widening it): `WedgeVerdict` (a value to switch on, never reconstructed
// from formatted text), `evaluateWedge()`, and every exported type in this
// file (`WedgeInput`/`WedgeResult` and the observation/assessment shapes).
// A caller that is not a CLI — WYZR-19 included — depends on exactly this
// surface. Nothing in src/cli-wedge.ts is part of it.
//
// THE CLOCK IS AN INPUT, NOT AN AMBIENT CALL (WYZR-16, added after this
// task was filed). `WedgeInput.now` is the only time source this module
// reads — there is no `Date.now()`, `setTimeout`, or other wall-clock read
// anywhere below, and there must never be one added: every quiet-threshold
// decision is a comparison against `now`, and an engine that reads the
// clock itself cannot be tested exactly AT a threshold boundary, only near
// one with a tolerance — a test that passes for the wrong reason. This
// repo is deliberately retry-free and timer-free with a deterministic
// suite; that is a property to preserve, not an accident specific to Wyze
// code. (Per-probe timeouts are a different, legitimate concern — real
// wall-clock timeouts belong in src/wedge-runner.ts's I/O layer, never
// here.)
//
// Ground truth this module encodes (WYZR-16/WYZR-17/WYZR-22's ticket, itself
// relaying two real incidents dated 2026-09-02 and 2026-09-10 — not
// re-measured by this module; see the ticket for the full account):
//
// 1. A wedge is PROVEN only when at least two INDEPENDENT outside
//    instruments are silent together, AND the local-connectivity control
//    was successfully read and reports healthy, AND every configured
//    direct path (ssh, tunnel ping) is confirmed dead. All three,
//    unconditionally — see point 5 below for why the control is a
//    PRECONDITION of PROVEN, never merely a tiebreaker for instruments
//    that happen to declare a shared dependency.
// 2. Independence is a REAL COMPUTATION over each instrument's declared
//    dependency set (InstrumentObservation.dependsOn), never a hardcoded
//    "we have >=2 probes, therefore independent." Two silent instruments
//    that share a declared dependency are NOT independent evidence unless
//    that shared dependency has been separately confirmed healthy by the
//    local-connectivity control (see computePairIndependence() below) —
//    this is "the independence trap" the ticket names as the hardest thing
//    in this task. This computation only ever runs once the control is
//    already confirmed healthy (point 5) — it decides WHICH pairs are
//    independent, never WHETHER the control gets to be skipped.
// 3. A green control-plane reading is recorded (WedgeResult.controlPlane)
//    but STRUCTURALLY INCAPABLE of flipping the verdict, and can never be
//    counted as one of the two instruments. Enforced two ways: (a)
//    ControlPlaneReading is not assignable to, and cannot be pushed into,
//    WedgeInput.instruments — see the `__brand` fields below, which give
//    every observation kind a distinct nominal tag so structural typing
//    alone cannot make one pass for another even if the rest of the shape
//    ever happened to coincide; (b) evaluateWedge() below never branches on
//    `input.controlPlane` before a verdict is chosen — it is only copied
//    into the reasons trail, always AFTER the verdict is already decided.
// 4. The default answer is REFUSE (NOT_PROVEN). PROVEN requires every
//    condition to be AFFIRMATIVELY established — absence of evidence is
//    never read as evidence. A missing, throwing, timed-out, or
//    unconfigured instrument reduces confidence: it is recorded in the
//    evidence trail and named in the reasons text, but its silence (or lack
//    thereof) is never counted toward the quorum — see assessInstrument()'s
//    `isSilent` derivation, which requires `outcome === "observed"`.
// 5. "I could not look" (the local-connectivity control itself failing) is
//    its own verdict, INCONCLUSIVE_BY_SHARED_CAUSE — never reported as
//    PROVEN and never as NOT_PROVEN ("the box is fine"). It only applies
//    once a quorum of silent instruments would otherwise be in play; a
//    single silent instrument (or zero) is just NOT_PROVEN — a single
//    silent probe is a network blip, not a shared-cause question.
//    CHECKED UNCONDITIONALLY (WYZR-22): once >= 2 instruments are silent,
//    `evaluateWedge()` checks `localControl.outcome === "healthy"` BEFORE
//    it ever looks at any instrument's declared `dependsOn` — a wedge
//    running every probe from one manager box means "no declared
//    dependency in common" is never actually "no shared cause"; it only
//    means the declaration is incomplete. So the control being read and
//    healthy is a precondition of PROVEN regardless of whether the silent
//    instruments' dependency sets happen to overlap, not a check that only
//    matters when they do.
// 6. An affirmatively "alive" direct path OUTRANKS the control precondition
//    above (WYZR-23). Point 5's argument — a broken local connection makes
//    every instrument go quiet for a reason unrelated to the suspect box —
//    is airtight for SILENCE; it says nothing about an affirmative answer,
//    because a broken local connection can suppress a reply but cannot
//    manufacture one. So when a direct path reads "alive", the shared-cause
//    exclusion has already been beaten: something on the far end answered,
//    which is direct, unconfounded evidence about the suspect box, strictly
//    better than anything the control could have told us. `evaluateWedge()`
//    checks for an "alive" direct path BEFORE the point-5 healthy-control
//    check can return INCONCLUSIVE_BY_SHARED_CAUSE, and returns NOT_PROVEN
//    instead — never INCONCLUSIVE, because "nothing can be concluded" would
//    then be a false statement about our own epistemic position. Scoped
//    narrowly: only "alive" qualifies — "dead" and "unconfirmed" say
//    nothing positive about the box, so point 5 still governs those cases
//    entirely, unchanged. And every verdict whose input contains an
//    "alive" direct path names it in `reasons`, emitted before any verdict
//    returns, so no early exit (including this one) can drop it from the
//    trail a human actually reads.

export const WedgeVerdict = {
  Proven: "PROVEN",
  NotProven: "NOT_PROVEN",
  InconclusiveBySharedCause: "INCONCLUSIVE_BY_SHARED_CAUSE",
} as const;
export type WedgeVerdict = (typeof WedgeVerdict)[keyof typeof WedgeVerdict];

export type ProbeOutcome = "observed" | "error" | "timeout" | "unconfigured";

/**
 * One outside instrument's observation, exactly as gathered by
 * src/wedge-probes.ts's boundary and assembled by src/wedge-runner.ts — this
 * module reads it, never fetches it. `dependsOn` is the instrument's
 * declared dependency set AS DATA (point 2 above) — e.g. both a
 * Jira-activity and a GitHub-activity instrument declare
 * `["manager-internet"]` because both are observed from the manager
 * machine (see README's "Three different machines" section) over that
 * machine's own internet connection.
 */
export interface InstrumentObservation {
  readonly __brand: "wedge-instrument";
  readonly name: string;
  readonly dependsOn: readonly string[];
  readonly quietThresholdMs: number;
  readonly outcome: ProbeOutcome;
  /** Epoch ms of the most recent activity this instrument observed from
   * outside the suspect box. Present (non-null) only when
   * `outcome === "observed"`. */
  readonly lastSeenAt: number | null;
  /** Fragment-safe diagnostic — same rule as src/devices.ts's fieldNote():
   * may name what happened and, where relevant, a value's TYPE, but never
   * any part of a secret or a raw response value. */
  readonly note: string | null;
}

export type DirectPathOutcome = "dead" | "alive" | "unconfirmed";

/**
 * ssh / tunnel-ping. "dead" is a POSITIVE claim (no response arrived within
 * the configured budget) — never the default reading of a probe error or a
 * misconfiguration; those read as "unconfirmed" instead. See
 * src/wedge-probes-real.ts's classifyDirectPath() for how "dead" is
 * established without parsing locale- and version-dependent stderr text.
 */
export interface DirectPathObservation {
  readonly __brand: "wedge-direct-path";
  readonly name: string;
  readonly outcome: DirectPathOutcome;
  readonly note: string | null;
}

export type LocalControlOutcome = "healthy" | "unhealthy" | "error" | "timeout" | "unconfigured";

/**
 * The shared-cause exclusion (README: "local-connectivity control"). A
 * SEPARATE, SINGULAR field on WedgeInput below — never a member of
 * `instruments`. There is no collection an editor could push this into that
 * the quorum/independence computation reads, so "the control cannot be
 * counted as an instrument" is a compile-time property, not a convention a
 * future edit could silently undo.
 */
export interface LocalConnectivityObservation {
  readonly __brand: "wedge-local-control";
  readonly name: string;
  readonly outcome: LocalControlOutcome;
  /** Dependency ids this control's success confirms as healthy (e.g.
   * `"manager-internet"`) — meaningful only when `outcome === "healthy"`.
   * An instrument's silence is usable as independent evidence, alongside
   * another silent instrument it shares a dependency with, only when every
   * shared dependency appears here. */
  readonly confirms: readonly string[];
  readonly note: string | null;
}

/**
 * tailscale-style control-plane liveness. Recorded for the evidence trail
 * only — see this module's top comment, point 3, for how its powerlessness
 * over the verdict is made structural rather than conventional. This type
 * carries none of InstrumentObservation's fields (`dependsOn`,
 * `quietThresholdMs`, `outcome: ProbeOutcome`), so it is not assignable to
 * `WedgeInput.instruments` on shape alone; the `__brand` tag makes that true
 * even in a hypothetical future where the rest of the shape converges.
 *
 * NOT SPECIFIC TO TAILSCALE (WYZR-16, second correction, 2026-09-10): the
 * name is a label for the evidence trail, nothing more — this type, and the
 * exclusion it enforces, is generic to ANY signal whose liveness says
 * nothing about whether the SUSPECT BOX is actually reachable. A live
 * hand-run against the real fleet plug on 2026-09-10 produced two more
 * measured instances of exactly this shape: the plug's own `P5`
 * (reachability) and `conn_state` properties both read as live/reachable
 * while saying nothing about whether the box behind the plug had actually
 * come back — the identical failure mode as tailscale's coordination
 * server reporting `Online=True` through the 2026-09-02 wedge. This task
 * does not probe the plug (out of scope — see the ticket's absolute
 * rules), so no plug-liveness reading exists here today; the requirement
 * this type satisfies is that if a LATER story ever added one, giving it
 * the `ControlPlaneReading` shape (or any shape that is not
 * `InstrumentObservation`) is what would make it structurally impossible
 * for that reading to be counted as an instrument or to flip a verdict —
 * the same guarantee this type already gives the tailscale case, for free.
 */
export interface ControlPlaneReading {
  readonly __brand: "wedge-control-plane";
  readonly name: string;
  readonly online: boolean | "unknown";
  readonly note: string | null;
}

export interface WedgeInput {
  /** Epoch ms "now" — injected so quiet-duration math is deterministic in
   * tests and never drifts between gathering an observation and scoring it. */
  readonly now: number;
  readonly instruments: readonly InstrumentObservation[];
  readonly directPaths: readonly DirectPathObservation[];
  readonly localControl: LocalConnectivityObservation;
  /** Informational only — see ControlPlaneReading's own comment. */
  readonly controlPlane: readonly ControlPlaneReading[];
}

export interface InstrumentAssessment {
  readonly name: string;
  readonly dependsOn: readonly string[];
  readonly outcome: ProbeOutcome;
  readonly lastSeenAt: number | null;
  readonly quietForMs: number | null;
  readonly quietThresholdMs: number;
  /** `true` only when `outcome === "observed"` AND `quietForMs` has reached
   * `quietThresholdMs`. An instrument whose probe errored, timed out, or was
   * never configured is NEVER silent here, regardless of how long it has
   * been since any prior reading — see this module's top comment, point 4. */
  readonly isSilent: boolean;
  /** Carried through from InstrumentObservation.note unchanged — why an
   * instrument is unconfigured, what an error/timeout actually was, or any
   * other fragment-safe diagnostic. Part of the evidence trail; a human
   * reading `wyzr wedge status` during the degrading window needs WHY an
   * instrument could not be read, not just that it could not be. */
  readonly note: string | null;
}

export interface IndependencePair {
  readonly a: string;
  readonly b: string;
  readonly sharedDependencies: readonly string[];
  readonly independent: boolean;
  readonly reason: string;
}

export interface WedgeResult {
  readonly verdict: WedgeVerdict;
  /** The full evidence trail's prose, in the order it was decided — this is
   * the "evidence is the product, the verdict is a summary of it" the
   * ticket requires the CLI to surface, not just a bare yes/no. */
  readonly reasons: readonly string[];
  readonly instruments: readonly InstrumentAssessment[];
  readonly directPaths: readonly DirectPathObservation[];
  readonly localControl: LocalConnectivityObservation;
  readonly controlPlane: readonly ControlPlaneReading[];
  readonly independentPairFound: IndependencePair | null;
  readonly independencePairs: readonly IndependencePair[];
}

function assessInstrument(obs: InstrumentObservation, now: number): InstrumentAssessment {
  const quietForMs = obs.outcome === "observed" && obs.lastSeenAt !== null ? now - obs.lastSeenAt : null;
  const isSilent = obs.outcome === "observed" && quietForMs !== null && quietForMs >= obs.quietThresholdMs;
  return {
    name: obs.name,
    dependsOn: obs.dependsOn,
    outcome: obs.outcome,
    lastSeenAt: obs.lastSeenAt,
    quietForMs,
    quietThresholdMs: obs.quietThresholdMs,
    isSilent,
    note: obs.note,
  };
}

/**
 * The independence computation itself (point 2 above). ONLY EVER CALLED
 * once `evaluateWedge()` has already confirmed the local-connectivity
 * control is `"healthy"` (point 5) — it decides WHICH pairs of silent
 * instruments are independent, never whether the control's own outcome
 * gets to be skipped. Two silent instruments with NO declared dependency in
 * common are independent with no further question — this is a statement
 * about their declared data, not a second, weaker way to rule out a shared
 * cause; the control having already been read and healthy is what makes it
 * safe to trust that declaration here. Two that DO share a dependency are
 * independent only if every shared dependency appears in the control's
 * `confirms` list — i.e. the shared cause has been affirmatively ruled out
 * for that specific dependency, not merely unmentioned.
 */
function computePairIndependence(
  a: InstrumentAssessment,
  b: InstrumentAssessment,
  localControl: LocalConnectivityObservation,
): IndependencePair {
  const sharedDependencies = a.dependsOn.filter((d) => b.dependsOn.includes(d));

  if (sharedDependencies.length === 0) {
    return { a: a.name, b: b.name, sharedDependencies, independent: true, reason: "no declared dependency in common" };
  }

  const plural = sharedDependencies.length === 1 ? "dependency" : "dependencies";

  const confirmed = new Set(localControl.confirms);
  const unconfirmed = sharedDependencies.filter((d) => !confirmed.has(d));
  if (unconfirmed.length > 0) {
    const unconfirmedPlural = unconfirmed.length === 1 ? "dependency" : "dependencies";
    return {
      a: a.name,
      b: b.name,
      sharedDependencies,
      independent: false,
      reason: `shared ${unconfirmedPlural} (${unconfirmed.join(", ")}) not confirmed healthy by the local-connectivity control`,
    };
  }

  return {
    a: a.name,
    b: b.name,
    sharedDependencies,
    independent: true,
    reason: `shared ${plural} (${sharedDependencies.join(", ")}) confirmed healthy by the local-connectivity control — silence is not attributable to it`,
  };
}

/**
 * The engine's single entry point. Never throws on malformed-but-typed
 * input (there is no I/O here to fail) — every branch below is total over
 * WedgeInput's type. See this module's top comment for the five properties
 * this function's control flow is built to guarantee.
 */
export function evaluateWedge(input: WedgeInput): WedgeResult {
  const reasons: string[] = [];
  const instruments = input.instruments.map((i) => assessInstrument(i, input.now));

  const notObserved = instruments.filter((i) => i.outcome !== "observed");
  for (const d of notObserved) {
    reasons.push(
      `instrument "${d.name}" could not be read (${d.outcome}) — excluded from the quorum, never treated as silent or active`,
    );
  }

  const silent = instruments.filter((i) => i.isSilent);
  const active = instruments.filter((i) => i.outcome === "observed" && !i.isSilent);
  for (const a of active) {
    reasons.push(
      `instrument "${a.name}" is active, not silent (quiet for ${a.quietForMs}ms, threshold ${a.quietThresholdMs}ms)`,
    );
  }

  // Named in `reasons` unconditionally, before any verdict below can
  // return — see this module's top comment, point 6. Whichever verdict is
  // ultimately reached, a human reading the trail must see that a direct
  // path answered; no early exit gets to drop this line.
  const aliveDirectPaths = input.directPaths.filter((p) => p.outcome === "alive");
  for (const p of aliveDirectPaths) {
    reasons.push(
      `direct path "${p.name}" read "alive" — direct, unconfounded evidence the suspect box is reachable (a broken local connection can suppress a reply, never manufacture one)`,
    );
  }

  const base = {
    instruments,
    directPaths: input.directPaths,
    localControl: input.localControl,
    controlPlane: input.controlPlane,
  };

  if (silent.length < 2) {
    reasons.push(
      `only ${silent.length} instrument(s) observed silent — at least 2 independently-silent instruments are required, never fewer`,
    );
    return { verdict: WedgeVerdict.NotProven, reasons, ...base, independentPairFound: null, independencePairs: [] };
  }

  // ALIVE OUTRANKS THE CONTROL PRECONDITION (WYZR-23, this module's top
  // comment point 6), checked BEFORE the INCONCLUSIVE_BY_SHARED_CAUSE
  // return just below so it can never be shadowed by it. Only fires when
  // the control precondition would otherwise apply (i.e. the control was
  // NOT read as healthy) — when the control IS healthy, the ordinary
  // independence/direct-path checks further down already handle an alive
  // path correctly (and already did, before this task). Only "alive"
  // qualifies; "dead" and "unconfirmed" fall through to the unchanged
  // WYZR-22 precondition below.
  if (input.localControl.outcome !== "healthy" && aliveDirectPaths.length > 0) {
    reasons.push(
      `>=2 instruments are silent and the local-connectivity control is "${input.localControl.outcome}", not ` +
        "healthy — but an affirmatively \"alive\" direct path is direct, positive evidence about the suspect box " +
        "that a broken local connection cannot manufacture, so this forces NOT_PROVEN rather than " +
        "INCONCLUSIVE_BY_SHARED_CAUSE, which would falsely claim nothing can be concluded",
    );
    return { verdict: WedgeVerdict.NotProven, reasons, ...base, independentPairFound: null, independencePairs: [] };
  }

  // PRECONDITION OF PROVEN (WYZR-22), checked BEFORE any pair's declared
  // dependencies are even looked at: once >= 2 instruments are silent, the
  // local-connectivity control must have been successfully read and report
  // "healthy", full stop. wyzr runs every probe from one manager box, so
  // "these two instruments declare no dependency in common" is never actual
  // proof their silence has no shared cause — it only means their
  // declarations don't mention the one dependency every instrument here
  // inherently has. Whatever the dependency sets look like, an unhealthy,
  // erroring, timed-out, or unconfigured control means the shared cause was
  // never ruled out, so this can never be scored as independent evidence —
  // it is INCONCLUSIVE_BY_SHARED_CAUSE, "I could not look," never PROVEN.
  // (Unless an alive direct path already returned above — see immediately
  // above this comment.)
  if (input.localControl.outcome !== "healthy") {
    reasons.push(
      `>=2 instruments are silent, but the local-connectivity control is "${input.localControl.outcome}", not ` +
        "healthy — the shared cause (this box's own connectivity) cannot be ruled out, so their silence cannot be " +
        "scored as independent evidence about the suspect box, regardless of their declared dependency sets",
    );
    return {
      verdict: WedgeVerdict.InconclusiveBySharedCause,
      reasons,
      ...base,
      independentPairFound: null,
      independencePairs: [],
    };
  }

  const pairs: IndependencePair[] = [];
  for (let x = 0; x < silent.length; x++) {
    for (let y = x + 1; y < silent.length; y++) {
      pairs.push(computePairIndependence(silent[x]!, silent[y]!, input.localControl));
    }
  }
  const independentPairFound = pairs.find((p) => p.independent) ?? null;

  if (!independentPairFound) {
    reasons.push(
      "no pair of silent instruments is independent — every pair shares a dependency the local-connectivity " +
        "control did not confirm healthy",
    );
    return { verdict: WedgeVerdict.NotProven, reasons, ...base, independentPairFound: null, independencePairs: pairs };
  }

  reasons.push(
    `independent silent pair found: "${independentPairFound.a}" and "${independentPairFound.b}" (${independentPairFound.reason})`,
  );

  if (input.directPaths.length === 0) {
    reasons.push("no direct paths were supplied — cannot establish that they are dead");
    return { verdict: WedgeVerdict.NotProven, reasons, ...base, independentPairFound, independencePairs: pairs };
  }

  const notDead = input.directPaths.filter((p) => p.outcome !== "dead");
  if (notDead.length > 0) {
    for (const p of notDead) {
      reasons.push(`direct path "${p.name}" is "${p.outcome}", not confirmed dead`);
    }
    return { verdict: WedgeVerdict.NotProven, reasons, ...base, independentPairFound, independencePairs: pairs };
  }
  reasons.push(`all ${input.directPaths.length} direct path(s) confirmed dead`);

  // Control-plane liveness is already part of `base` (returned to the
  // caller as evidence) but DELIBERATELY NEVER READ above this line, in
  // either direction — see this module's top comment, point 3. Recording it
  // into `reasons` here, after the verdict is already PROVEN, cannot change
  // that verdict; it only makes the informational reading legible in the
  // trail a human reads.
  for (const cp of input.controlPlane) {
    reasons.push(`control-plane reading "${cp.name}" recorded as ${cp.online} — informational only, cannot affect this verdict`);
  }

  reasons.push("PROVEN: >=2 independently-silent instruments, shared cause ruled out, all direct paths dead");
  return { verdict: WedgeVerdict.Proven, reasons, ...base, independentPairFound, independencePairs: pairs };
}
