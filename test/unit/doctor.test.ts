// Pure decision-core tests for src/doctor.ts — zero I/O, hand-built
// DoctorInput fixtures throughout. Mirrors test/unit/recovery.test.ts's own
// shape: one fixture that passes everything, then one mutation per test to
// isolate exactly which input flips the verdict.

import { describe, expect, test } from "bun:test";
import { blockedByPrerequisite, DoctorVerdict, evaluateDoctorVerdict, type DoctorInput, type DoctorPlugCheck } from "../../src/doctor.ts";

function passingPlug(label: "fleetPlug" | "safePlug"): DoctorPlugCheck {
  return {
    label,
    mac: `AA:BB:CC:DD:EE:${label === "fleetPlug" ? "01" : "02"}`,
    model: "WLPP1CFH",
    name: `fixture-${label}`,
    resolvable: "pass",
    resolvableNote: "found",
    readable: "pass",
    readableNote: "power=on reachable=true",
  };
}

/** Every check affirmatively passing — the only input that should reach
 * READY. Every test below mutates exactly one field off this baseline. */
function allPassing(): DoctorInput {
  return {
    config: { outcome: "pass", note: null, optionalSections: { jira: true, github: true } },
    credentials: { outcome: "pass", note: null },
    cloud: { outcome: "pass", note: null },
    fleetPlug: passingPlug("fleetPlug"),
    safePlug: passingPlug("safePlug"),
    instruments: [
      { name: "jira-activity", outcome: "pass", note: null },
      { name: "github-activity", outcome: "pass", note: null },
    ],
    wrongBoxGuard: { outcome: "not_target", reasons: ["resolves to addresses that do not overlap this machine's own"] },
    wrongBoxGuardBlockedByMissingConfig: false,
    unproven: ["static unproven note"],
  };
}

describe("evaluateDoctorVerdict — READY", () => {
  test("every check passing -> READY, exit-mappable to Ok", () => {
    const result = evaluateDoctorVerdict(allPassing());
    expect(result.verdict).toBe(DoctorVerdict.Ready);
    expect(result.reasons.at(-1)).toContain("VERDICT: READY");
  });
});

describe("evaluateDoctorVerdict — rule 1: any FAIL outranks everything else -> NOT_READY", () => {
  test("named test: config present-but-broken (fail) alone forces NOT_READY", () => {
    const input = allPassing();
    const broken: DoctorInput = { ...input, config: { outcome: "fail", note: "config file has bad permissions", optionalSections: {} } };
    const result = evaluateDoctorVerdict(broken);
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });

  test("named test: a configured plug that fails to resolve forces NOT_READY", () => {
    const input = allPassing();
    const unresolvable: DoctorInput = {
      ...input,
      fleetPlug: { ...input.fleetPlug, resolvable: "fail", resolvableNote: "mac not found in account's device list" },
    };
    expect(evaluateDoctorVerdict(unresolvable).verdict).toBe(DoctorVerdict.NotReady);
  });

  test("named test: the wrong-box guard affirmatively finding is_target forces NOT_READY, never buried as could-not-look", () => {
    const input = allPassing();
    const isTarget: DoctorInput = {
      ...input,
      wrongBoxGuard: { outcome: "is_target", reasons: ["resolves to an address this machine itself owns"] },
    };
    const result = evaluateDoctorVerdict(isTarget);
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
    expect(result.checks.wrongBoxGuard).toBe("fail");
  });

  test("a FAIL still wins even when another check is could-not-look and another is not-configured", () => {
    const input = allPassing();
    const mixed: DoctorInput = {
      ...input,
      cloud: { outcome: "fail", note: "login attempt did not succeed" },
      instruments: [
        { name: "jira-activity", outcome: "could-not-look", note: "timeout" },
        { name: "github-activity", outcome: "not-configured", note: null },
      ],
    };
    expect(evaluateDoctorVerdict(mixed).verdict).toBe(DoctorVerdict.NotReady);
  });
});

describe("evaluateDoctorVerdict — rule 2: could-not-look (with no fail) -> INCONCLUSIVE, never flattened to a pass or a fail", () => {
  test("named test: 'could not look' is its own outcome, neither pass nor fail", () => {
    const input = allPassing();
    const inconclusive: DoctorInput = {
      ...input,
      fleetPlug: { ...input.fleetPlug, readable: "could-not-look", readableNote: "P3/P5 undecodable" },
    };
    const result = evaluateDoctorVerdict(inconclusive);
    expect(result.verdict).toBe(DoctorVerdict.Inconclusive);
    expect(result.verdict).not.toBe(DoctorVerdict.Ready);
    // Distinctness at the type level: could-not-look is never coerced to
    // "pass" or "fail" anywhere in this pipeline.
    expect(result.checks.fleetPlugReadable).toBe("could-not-look");
    expect(result.checks.fleetPlugReadable).not.toBe("pass");
    expect(result.checks.fleetPlugReadable).not.toBe("fail");
  });

  test("a genuine (non-config-blocked) wrong-box guard inconclusive reads as could-not-look, not not-configured", () => {
    const input = allPassing();
    const dnsFailed: DoctorInput = {
      ...input,
      wrongBoxGuard: { outcome: "inconclusive", reasons: ["could not resolve the configured target"] },
      wrongBoxGuardBlockedByMissingConfig: false,
    };
    const result = evaluateDoctorVerdict(dnsFailed);
    expect(result.checks.wrongBoxGuard).toBe("could-not-look");
    expect(result.verdict).toBe(DoctorVerdict.Inconclusive);
  });
});

describe("evaluateDoctorVerdict — rule 3: not-configured (nothing failed, nothing unreadable) -> UNCONFIGURED", () => {
  test("named test: a totally fresh install (config missing) reads as UNCONFIGURED, never NOT_READY", () => {
    const input: DoctorInput = {
      config: { outcome: "not-configured", note: "no config file found", optionalSections: {} },
      credentials: { outcome: "not-configured", note: "no credentials file found" },
      cloud: { outcome: "not-configured", note: 'blocked — the credentials check is "not-configured"' },
      fleetPlug: {
        label: "fleetPlug",
        mac: null,
        model: null,
        name: null,
        resolvable: "not-configured",
        resolvableNote: "blocked",
        readable: "not-configured",
        readableNote: "blocked",
      },
      safePlug: {
        label: "safePlug",
        mac: null,
        model: null,
        name: null,
        resolvable: "not-configured",
        resolvableNote: "blocked",
        readable: "not-configured",
        readableNote: "blocked",
      },
      instruments: [
        { name: "jira-activity", outcome: "not-configured", note: null },
        { name: "github-activity", outcome: "not-configured", note: null },
      ],
      wrongBoxGuard: { outcome: "inconclusive", reasons: ["no configured target host"] },
      wrongBoxGuardBlockedByMissingConfig: true,
      unproven: [],
    };
    const result = evaluateDoctorVerdict(input);
    expect(result.verdict).toBe(DoctorVerdict.Unconfigured);
    expect(result.checks.wrongBoxGuard).toBe("not-configured");
  });

  test("an otherwise-healthy install with one never-configured optional instrument still reads UNCONFIGURED, not READY", () => {
    const input = allPassing();
    const oneGap: DoctorInput = {
      ...input,
      instruments: [{ name: "jira-activity", outcome: "pass", note: null }, { name: "github-activity", outcome: "not-configured", note: null }],
    };
    expect(evaluateDoctorVerdict(oneGap).verdict).toBe(DoctorVerdict.Unconfigured);
  });
});

describe("blockedByPrerequisite — the propagation rule", () => {
  test("not-configured propagates as itself", () => {
    expect(blockedByPrerequisite("not-configured")).toBe("not-configured");
  });
  test("fail propagates as could-not-look, not as fail", () => {
    expect(blockedByPrerequisite("fail")).toBe("could-not-look");
  });
  test("could-not-look propagates as could-not-look", () => {
    expect(blockedByPrerequisite("could-not-look")).toBe("could-not-look");
  });
});

describe("evaluateDoctorVerdict — wrong-box guard mapping never loses the raw outcome/reasons", () => {
  test("is_target's raw outcome and evidence trail survive verbatim in the report even though it maps to fail for the verdict", () => {
    const input = allPassing();
    const reasons = ["resolves to address(es) this machine itself owns (10.0.0.5)"];
    const isTarget: DoctorInput = { ...input, wrongBoxGuard: { outcome: "is_target", reasons } };
    const result = evaluateDoctorVerdict(isTarget);
    expect(result.wrongBoxGuard.outcome).toBe("is_target");
    expect(result.wrongBoxGuard.reasons).toEqual(reasons);
  });
});
