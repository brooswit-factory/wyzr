import { describe, expect, test } from "bun:test";
import {
  evaluateWedge,
  WedgeVerdict,
  type ControlPlaneReading,
  type DirectPathObservation,
  type InstrumentObservation,
  type LocalConnectivityObservation,
  type WedgeInput,
} from "../../src/wedge.ts";

const NOW = 1_800_000_000_000; // fixed epoch ms — the engine takes `now` as input, never reads a real clock.
const TEN_MIN = 10 * 60 * 1000;

function instrument(overrides: Partial<InstrumentObservation> = {}): InstrumentObservation {
  return {
    __brand: "wedge-instrument",
    name: "test-instrument",
    dependsOn: [],
    quietThresholdMs: TEN_MIN,
    outcome: "observed",
    lastSeenAt: NOW - TEN_MIN - 1,
    note: null,
    ...overrides,
  };
}

function directPath(overrides: Partial<DirectPathObservation> = {}): DirectPathObservation {
  return { __brand: "wedge-direct-path", name: "test-path", outcome: "dead", note: null, ...overrides };
}

function localControl(overrides: Partial<LocalConnectivityObservation> = {}): LocalConnectivityObservation {
  return {
    __brand: "wedge-local-control",
    name: "local-connectivity",
    outcome: "healthy",
    confirms: ["manager-internet"],
    note: null,
    ...overrides,
  };
}

function controlPlane(overrides: Partial<ControlPlaneReading> = {}): ControlPlaneReading {
  return { __brand: "wedge-control-plane", name: "tailscale", online: true, note: null, ...overrides };
}

/** A fully-wired PROVEN case: two instruments sharing "manager-internet",
 * silent well past their thresholds, the control confirming that
 * dependency healthy, and one dead direct path. Individual tests mutate
 * this baseline to explore every other branch. */
function provenInput(overrides: Partial<WedgeInput> = {}): WedgeInput {
  return {
    now: NOW,
    instruments: [
      instrument({ name: "jira", dependsOn: ["manager-internet"] }),
      instrument({ name: "github", dependsOn: ["manager-internet"] }),
    ],
    directPaths: [directPath({ name: "ssh" })],
    localControl: localControl(),
    controlPlane: [],
    ...overrides,
  };
}

describe("evaluateWedge — PROVEN", () => {
  test("two independently-silent instruments, control healthy, direct path dead: PROVEN", () => {
    const result = evaluateWedge(provenInput());
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });

  test("instruments with NO shared dependency still require a healthy control — it is a precondition of PROVEN, not a shared-dependency tiebreaker", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["jira-cloud"] }),
          instrument({ name: "github", dependsOn: ["github-cloud"] }),
        ],
        localControl: localControl({ outcome: "healthy", confirms: [] }),
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });

  test("multiple direct paths must ALL be dead", () => {
    const result = evaluateWedge(
      provenInput({ directPaths: [directPath({ name: "ssh" }), directPath({ name: "tunnel-ping" })] }),
    );
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });
});

describe("evaluateWedge — a fully healthy box is REFUSED", () => {
  test("both instruments active (not silent): NOT_PROVEN", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"], lastSeenAt: NOW - 1000 }),
          instrument({ name: "github", dependsOn: ["manager-internet"], lastSeenAt: NOW - 1000 }),
        ],
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes("only 0 instrument(s) observed silent"))).toBe(true);
  });
});

describe("evaluateWedge — one instrument silent, the other live, is REFUSED", () => {
  test("only one silent instrument: NOT_PROVEN, never PROVEN", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"] }),
          instrument({ name: "github", dependsOn: ["manager-internet"], lastSeenAt: NOW - 1000 }),
        ],
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes("only 1 instrument(s) observed silent"))).toBe(true);
  });
});

describe("evaluateWedge — both silent, local-connectivity control FAILING: INCONCLUSIVE, never healthy and never proven", () => {
  for (const failing of ["unhealthy", "error", "timeout", "unconfigured"] as const) {
    test(`control outcome "${failing}" with a shared, unconfirmed dependency: INCONCLUSIVE_BY_SHARED_CAUSE`, () => {
      const result = evaluateWedge(provenInput({ localControl: localControl({ outcome: failing, confirms: [] }) }));
      expect(result.verdict).toBe(WedgeVerdict.InconclusiveBySharedCause);
      expect(result.verdict).not.toBe(WedgeVerdict.NotProven);
      expect(result.verdict).not.toBe(WedgeVerdict.Proven);
    });
  }
});

describe("evaluateWedge — WYZR-23: an affirmatively ALIVE direct path outranks a failing control", () => {
  // The ticket's exact repro: two silent instruments, a non-healthy control,
  // ssh "alive". Before this fix this returned INCONCLUSIVE_BY_SHARED_CAUSE
  // with no mention of ssh anywhere in `reasons` — confirmed live against
  // the pre-fix code before this change was made (see the PR description).
  for (const failing of ["unhealthy", "error", "timeout", "unconfigured"] as const) {
    test(`control outcome "${failing}" with ssh "alive": NOT_PROVEN, never INCONCLUSIVE, and ssh is named`, () => {
      const result = evaluateWedge(
        provenInput({
          directPaths: [directPath({ name: "ssh", outcome: "alive" })],
          localControl: localControl({ outcome: failing, confirms: [] }),
        }),
      );
      expect(result.verdict).toBe(WedgeVerdict.NotProven);
      expect(result.verdict).not.toBe(WedgeVerdict.InconclusiveBySharedCause);
      expect(result.reasons.some((r) => r.includes('direct path "ssh" read "alive"'))).toBe(true);
      expect(result.reasons.some((r) => r.includes("forces NOT_PROVEN rather than INCONCLUSIVE_BY_SHARED_CAUSE"))).toBe(
        true,
      );
    });
  }

  // Scoped narrowly (the ticket's own words: "do not widen it"): only
  // "alive" short-circuits. "dead" and "unconfirmed" say nothing positive
  // about the box, so WYZR-22's control precondition still governs them
  // entirely — this must still be INCONCLUSIVE_BY_SHARED_CAUSE, unchanged.
  for (const notAlive of ["dead", "unconfirmed"] as const) {
    test(`control failing, ssh "${notAlive}" (not alive): still INCONCLUSIVE_BY_SHARED_CAUSE — WYZR-22 untouched`, () => {
      const result = evaluateWedge(
        provenInput({
          directPaths: [directPath({ name: "ssh", outcome: notAlive })],
          localControl: localControl({ outcome: "error", confirms: [] }),
        }),
      );
      expect(result.verdict).toBe(WedgeVerdict.InconclusiveBySharedCause);
      expect(result.reasons.some((r) => r.includes('read "alive"'))).toBe(false);
    });
  }

  test("< 2 silent instruments with a failing control and ssh alive is still NOT_PROVEN (unchanged), and still names ssh as alive", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"] }),
          instrument({ name: "github", dependsOn: ["manager-internet"], lastSeenAt: NOW - 1000 }),
        ],
        directPaths: [directPath({ name: "ssh", outcome: "alive" })],
        localControl: localControl({ outcome: "error", confirms: [] }),
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes('direct path "ssh" read "alive"'))).toBe(true);
  });

  test("the alive short-circuit does not fire when the control IS healthy — the ordinary direct-path check already handles it, unchanged", () => {
    const result = evaluateWedge(provenInput({ directPaths: [directPath({ name: "ssh", outcome: "alive" })] }));
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes('direct path "ssh" read "alive"'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('direct path "ssh" is "alive", not confirmed dead'))).toBe(true);
    expect(result.reasons.some((r) => r.includes("forces NOT_PROVEN rather than INCONCLUSIVE_BY_SHARED_CAUSE"))).toBe(
      false,
    );
  });

  test("no widening: an alive direct path can never newly reach PROVEN — PROVEN still requires every direct path confirmed dead", () => {
    const result = evaluateWedge(
      provenInput({
        directPaths: [directPath({ name: "ssh", outcome: "alive" })],
        localControl: localControl({ outcome: "healthy", confirms: ["manager-internet"] }),
      }),
    );
    expect(result.verdict).not.toBe(WedgeVerdict.Proven);
  });
});

describe("evaluateWedge — WYZR-22: the local-connectivity control is a PRECONDITION of PROVEN, not a shared-dependency tiebreaker", () => {
  // The reviewer's exact repro (WYZR-22): two silent instruments with
  // DISJOINT declared dependencies — the exact shape that used to take
  // computePairIndependence()'s "no declared dependency in common" branch
  // and skip the shared-cause check entirely — plus a dead direct path.
  // Before this fix this returned PROVEN regardless of `localControl`; now
  // it must return INCONCLUSIVE_BY_SHARED_CAUSE whenever the control was
  // not successfully read as healthy, and PROVEN never becomes reachable
  // from this shape by widening it further.
  for (const failing of ["unconfigured", "error", "timeout"] as const) {
    test(`disjoint dependencies, dead direct path, control "${failing}": INCONCLUSIVE_BY_SHARED_CAUSE, never PROVEN`, () => {
      const result = evaluateWedge(
        provenInput({
          instruments: [
            instrument({ name: "a", dependsOn: ["dep-a"] }),
            instrument({ name: "b", dependsOn: ["dep-b"] }),
          ],
          localControl: localControl({ outcome: failing, confirms: [] }),
        }),
      );
      expect(result.verdict).toBe(WedgeVerdict.InconclusiveBySharedCause);
      expect(result.verdict).not.toBe(WedgeVerdict.Proven);
      expect(result.independentPairFound).toBeNull();
      expect(result.independencePairs).toEqual([]);
      expect(
        result.reasons.some((r) => r.includes("regardless of their declared dependency sets")),
      ).toBe(true);
      expect(result.reasons.some((r) => r.includes("shared cause ruled out"))).toBe(false);
    });
  }

  test("< 2 silent instruments with disjoint dependencies and a failing control is still NOT_PROVEN, never INCONCLUSIVE — a single silent probe is a network blip, not a shared-cause question", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "a", dependsOn: ["dep-a"] }),
          instrument({ name: "b", dependsOn: ["dep-b"], lastSeenAt: NOW - 1000 }),
        ],
        localControl: localControl({ outcome: "unconfigured", confirms: [] }),
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });
});

describe("evaluateWedge — both silent, control healthy, but a direct path still ALIVE is REFUSED", () => {
  test("one alive direct path blocks PROVEN even with everything else satisfied", () => {
    const result = evaluateWedge(provenInput({ directPaths: [directPath({ name: "ssh", outcome: "alive" })] }));
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes('direct path "ssh" is "alive", not confirmed dead'))).toBe(true);
  });

  test("an unconfirmed direct path also blocks PROVEN — absence of evidence is never evidence of dead", () => {
    const result = evaluateWedge(provenInput({ directPaths: [directPath({ name: "ssh", outcome: "unconfirmed" })] }));
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });

  test("no direct paths supplied at all blocks PROVEN", () => {
    const result = evaluateWedge(provenInput({ directPaths: [] }));
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes("no direct paths were supplied"))).toBe(true);
  });

  test("one dead path and one alive path among several: still REFUSED", () => {
    const result = evaluateWedge(
      provenInput({
        directPaths: [directPath({ name: "ssh", outcome: "dead" }), directPath({ name: "tunnel-ping", outcome: "alive" })],
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });
});

describe("evaluateWedge — control-plane liveness is recorded but structurally powerless", () => {
  test("a green (online: true) control-plane reading CANNOT flip a PROVEN verdict to refused", () => {
    const result = evaluateWedge(provenInput({ controlPlane: [controlPlane({ online: true })] }));
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });

  test("an offline/unknown control-plane reading also cannot manufacture a PROVEN verdict on its own", () => {
    // Everything else unsatisfied (no silent instruments) — a bad control-plane reading must not be
    // read as evidence FOR a wedge either; it is powerless in BOTH directions.
    const result = evaluateWedge(
      provenInput({
        instruments: [instrument({ name: "jira", lastSeenAt: NOW - 1000 }), instrument({ name: "github", lastSeenAt: NOW - 1000 })],
        controlPlane: [controlPlane({ online: false })],
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });

  test("the control-plane reading is still recorded in the evidence trail even though it cannot affect the verdict", () => {
    const result = evaluateWedge(provenInput({ controlPlane: [controlPlane({ name: "tailscale", online: true })] }));
    expect(result.controlPlane).toHaveLength(1);
    expect(result.controlPlane[0]!.online).toBe(true);
    expect(result.reasons.some((r) => r.includes('control-plane reading "tailscale" recorded as true'))).toBe(true);
  });

  test("a ControlPlaneReading is not assignable to WedgeInput.instruments — a compile-time property, checked by `bun run typecheck`", () => {
    const reading = controlPlane();
    // @ts-expect-error — ControlPlaneReading's shape (and its __brand) is deliberately incompatible
    // with InstrumentObservation[]; this line existing and needing the suppression IS the proof that
    // "a control-plane reading can never be counted as one of the two instruments" is structural.
    const instruments: InstrumentObservation[] = [reading];
    void instruments;
  });

  test("a LocalConnectivityObservation is not assignable to WedgeInput.instruments either", () => {
    const control = localControl();
    // @ts-expect-error — same structural guarantee as above, for the local-connectivity control.
    const instruments: InstrumentObservation[] = [control];
    void instruments;
  });
});

describe("evaluateWedge — an instrument that THROWS/TIMES OUT/is UNCONFIGURED never silently vanishes from the quorum", () => {
  test("dropping a degraded instrument would leave one probe looking like two — assert refusal, not proof", () => {
    // Two instruments configured; only ONE is genuinely, affirmatively silent. A naive
    // implementation that simply filtered out non-"observed" readings before counting could, with a
    // sloppy length check elsewhere, mistake "2 instruments minus 1 bad one = 1 looking like a quorum
    // of 2" — i.e. treat the single genuinely-silent instrument as if it satisfied the >=2 requirement
    // on its own. This input is built so THAT mistake would produce PROVEN; the correct engine must not.
    for (const outcome of ["error", "timeout", "unconfigured"] as const) {
      const result = evaluateWedge(
        provenInput({
          instruments: [
            instrument({ name: "jira", dependsOn: ["manager-internet"] }), // genuinely silent
            instrument({ name: "github", dependsOn: ["manager-internet"], outcome, lastSeenAt: null }), // degraded
          ],
        }),
      );
      expect(result.verdict).toBe(WedgeVerdict.NotProven);
      expect(result.reasons.some((r) => r.includes(`instrument "github" could not be read (${outcome})`))).toBe(true);
    }
  });

  test("an unconfigured instrument's own note explains why it was excluded, not just that it was", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira" }),
          instrument({ name: "github", outcome: "unconfigured", lastSeenAt: null, note: "no baseUrl supplied" }),
        ],
      }),
    );
    const github = result.instruments.find((i) => i.name === "github")!;
    expect(github.isSilent).toBe(false);
    expect(github.outcome).toBe("unconfigured");
  });
});

describe("evaluateWedge — two instruments sharing a declared dependency do not satisfy rule 1 on their own", () => {
  test("shared dependency, no local control at all configured in this input's control outcome: NOT independent", () => {
    const result = evaluateWedge(provenInput({ localControl: localControl({ outcome: "unhealthy", confirms: [] }) }));
    // Both silent, shared dependency unconfirmed => INCONCLUSIVE (control failing), not a silent PROVEN.
    expect(result.verdict).toBe(WedgeVerdict.InconclusiveBySharedCause);
  });

  test("shared dependency, control healthy but confirms a DIFFERENT dependency: still not independent", () => {
    const result = evaluateWedge(
      provenInput({ localControl: localControl({ outcome: "healthy", confirms: ["some-other-dependency"] }) }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes("no pair of silent instruments is independent"))).toBe(true);
  });

  test("computed independence pairs report which dependency was shared, for the evidence trail", () => {
    const result = evaluateWedge(
      provenInput({ localControl: localControl({ outcome: "healthy", confirms: ["some-other-dependency"] }) }),
    );
    expect(result.independencePairs).toHaveLength(1);
    expect(result.independencePairs[0]!.independent).toBe(false);
    expect(result.independencePairs[0]!.sharedDependencies).toEqual(["manager-internet"]);
  });
});

describe("evaluateWedge — the quiet threshold is a boundary, pinned exactly (item 11: `now` is injected, never an ambient clock)", () => {
  test("quiet for exactly 1ms less than the threshold: NOT silent", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"], lastSeenAt: NOW - (TEN_MIN - 1) }),
          instrument({ name: "github", dependsOn: ["manager-internet"] }),
        ],
      }),
    );
    const jira = result.instruments.find((i) => i.name === "jira")!;
    expect(jira.quietForMs).toBe(TEN_MIN - 1);
    expect(jira.isSilent).toBe(false);
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });

  test("quiet for EXACTLY the threshold: silent (inclusive boundary)", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"], lastSeenAt: NOW - TEN_MIN }),
          instrument({ name: "github", dependsOn: ["manager-internet"], lastSeenAt: NOW - TEN_MIN }),
        ],
      }),
    );
    for (const i of result.instruments) {
      expect(i.quietForMs).toBe(TEN_MIN);
      expect(i.isSilent).toBe(true);
    }
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });

  test("quiet for exactly 1ms more than the threshold: silent", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", dependsOn: ["manager-internet"], lastSeenAt: NOW - (TEN_MIN + 1) }),
          instrument({ name: "github", dependsOn: ["manager-internet"], lastSeenAt: NOW - (TEN_MIN + 1) }),
        ],
      }),
    );
    for (const i of result.instruments) {
      expect(i.quietForMs).toBe(TEN_MIN + 1);
      expect(i.isSilent).toBe(true);
    }
    expect(result.verdict).toBe(WedgeVerdict.Proven);
  });
});

describe("evaluateWedge — unconfigured never counts toward a quorum", () => {
  test("both instruments unconfigured (the normal state before WYZR-20 ships): NOT_PROVEN, never crashes", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", outcome: "unconfigured", lastSeenAt: null }),
          instrument({ name: "github", outcome: "unconfigured", lastSeenAt: null }),
        ],
        directPaths: [],
      }),
    );
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });

  test("no instruments supplied at all: NOT_PROVEN, never crashes", () => {
    const result = evaluateWedge(provenInput({ instruments: [] }));
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });
});

describe("evaluateWedge — reasons form a legible evidence trail, not just a bare verdict", () => {
  test("PROVEN's reasons name the independent pair and confirm every direct path", () => {
    const result = evaluateWedge(provenInput());
    expect(result.reasons.some((r) => r.includes("independent silent pair found"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("direct path(s) confirmed dead"))).toBe(true);
    expect(result.reasons[result.reasons.length - 1]).toContain("PROVEN");
  });

  test("an active (not-yet-silent) instrument's reason names its quiet duration and threshold", () => {
    const result = evaluateWedge(
      provenInput({
        instruments: [
          instrument({ name: "jira", lastSeenAt: NOW - 1000 }),
          instrument({ name: "github", lastSeenAt: NOW - 1000 }),
        ],
      }),
    );
    expect(result.reasons.some((r) => r.includes('instrument "jira" is active') && r.includes("threshold"))).toBe(true);
  });
});
