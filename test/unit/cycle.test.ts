import { describe, expect, test } from "bun:test";
import { decideGate } from "../../src/cycle.ts";
import { WedgeVerdict, type WedgeResult } from "../../src/wedge.ts";

function wedgeResult(verdict: WedgeVerdict): WedgeResult {
  return {
    verdict,
    reasons: [`fixture: verdict fixed to ${verdict}`],
    instruments: [],
    directPaths: [],
    localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
    controlPlane: [],
    independentPairFound: null,
    independencePairs: [],
  };
}

describe("decideGate — D3/D5: PROVEN proceeds with no extra ceremony", () => {
  test("PROVEN, not forced -> proceeds", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.Proven), false);
    expect(decision.proceeds).toBe(true);
  });

  test("PROVEN, forced -> still proceeds (force is irrelevant here, not a second requirement)", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.Proven), true);
    expect(decision.proceeds).toBe(true);
  });
});

describe("decideGate — named test 1: gate NOT_PROVEN, not forced -> refuses (D3: default refuse)", () => {
  test("NOT_PROVEN, not forced -> does not proceed", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.NotProven), false);
    expect(decision.proceeds).toBe(false);
    expect(decision.reason).toContain("REFUSING");
  });
});

describe("decideGate — named test 2: gate INCONCLUSIVE, not forced -> refuses, and the reason names INCONCLUSIVE distinctly from NOT_PROVEN", () => {
  test("INCONCLUSIVE_BY_SHARED_CAUSE, not forced -> does not proceed, reason names the actual verdict value", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.InconclusiveBySharedCause), false);
    expect(decision.proceeds).toBe(false);
    expect(decision.reason).toContain(WedgeVerdict.InconclusiveBySharedCause);
    expect(decision.reason).not.toContain(WedgeVerdict.NotProven);
  });
});

describe("decideGate — D4: force overrides the JUDGMENT", () => {
  test("NOT_PROVEN, forced -> proceeds, and says so", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.NotProven), true);
    expect(decision.proceeds).toBe(true);
    expect(decision.reason).toContain("human-forced");
  });

  test("INCONCLUSIVE_BY_SHARED_CAUSE, forced -> proceeds", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.InconclusiveBySharedCause), true);
    expect(decision.proceeds).toBe(true);
  });

  test("the force-overrides reason explicitly disclaims overriding the wrong-box guard or preconditions", () => {
    const decision = decideGate(wedgeResult(WedgeVerdict.NotProven), true);
    expect(decision.reason).toContain("does not, and structurally cannot, override");
  });
});
