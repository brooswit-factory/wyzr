import { describe, expect, test } from "bun:test";
import {
  evaluateRecovery,
  RecoveryVerdict,
  type PlugLivenessReading,
  type RecoveryDaemonObservation,
  type RecoveryDirectPathObservation,
  type RecoveryFleetObservation,
  type RecoveryInput,
  type RecoveryInstrumentObservation,
  type RecoveryUptimeObservation,
} from "../../src/recovery.ts";
import type { LocalConnectivityObservation } from "../../src/wedge.ts";

const SINCE = 1_800_000_000_000; // the power-off instant — fixed, the engine takes it as input, never reads a real clock.
const NOW = SINCE + 100_000; // 100s after the cut.
const ELAPSED = NOW - SINCE;

function directPath(overrides: Partial<RecoveryDirectPathObservation> = {}): RecoveryDirectPathObservation {
  return { __brand: "recovery-direct-path", name: "ssh", outcome: "alive", note: null, ...overrides };
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

function uptime(overrides: Partial<RecoveryUptimeObservation> = {}): RecoveryUptimeObservation {
  return { __brand: "recovery-uptime", outcome: "observed", uptimeMs: ELAPSED - 50_000, note: null, ...overrides };
}

function daemon(overrides: Partial<RecoveryDaemonObservation> = {}): RecoveryDaemonObservation {
  return { __brand: "recovery-daemon", outcome: "healthy", unit: "test.service", scope: "user", note: null, ...overrides };
}

function instrument(overrides: Partial<RecoveryInstrumentObservation> = {}): RecoveryInstrumentObservation {
  return {
    __brand: "recovery-instrument",
    name: "jira-activity",
    outcome: "observed",
    lastSeenAt: SINCE + 1000,
    note: null,
    ...overrides,
  };
}

function fleet(overrides: Partial<RecoveryFleetObservation> = {}): RecoveryFleetObservation {
  return { __brand: "recovery-fleet", outcome: "enumerated", totalCandidates: 2, flaggedCount: 2, bareCount: 0, note: null, ...overrides };
}

/** A fully-wired RECOVERED baseline — every check configured and passing.
 * Individual tests mutate this to explore every other branch, same pattern
 * as test/unit/wedge.test.ts's `provenInput()`. */
function recoveredInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    now: NOW,
    since: SINCE,
    reachability: [directPath({ name: "ssh" }), directPath({ name: "tunnel-ping" })],
    localControl: localControl(),
    uptime: uptime(),
    daemon: daemon(),
    instruments: [instrument({ name: "jira-activity" }), instrument({ name: "github-activity" })],
    fleet: fleet(),
    ...overrides,
  };
}

describe("evaluateRecovery — RECOVERED", () => {
  test("every check configured and passing: RECOVERED", () => {
    const result = evaluateRecovery(recoveredInput());
    expect(result.verdict).toBe(RecoveryVerdict.Recovered);
  });
});

describe("evaluateRecovery — reboot check (named tests 1/2/3)", () => {
  test("named test 1: a box that never rebooted (uptime older than the reference instant) is reported NOT_RECOVERED", () => {
    const result = evaluateRecovery(recoveredInput({ uptime: uptime({ uptimeMs: ELAPSED + 1 }) }));
    expect(result.checks.reboot).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("uptime just under elapsed (the PASS side of the boundary): reboot check passes", () => {
    // Renamed from the pre-review "named test 2: BEHIND"/"named test 2:
    // AHEAD" pair (a review caught them byte-identical, constructing no
    // skewed clock — see the type-level pin immediately below for what
    // actually proves named test 2's property). This test asserts only
    // what it can honestly claim: the ordinary PASS branch of the duration
    // comparison, one tick under the threshold.
    const result = evaluateRecovery(recoveredInput({ uptime: uptime({ uptimeMs: ELAPSED - 1 }) }));
    expect(result.checks.reboot).toBe("pass");
    expect(result.verdict).toBe(RecoveryVerdict.Recovered);
  });

  test(
    "named test 2: RecoveryUptimeObservation admits no wall-clock/boot-instant field — a type-level pin " +
      "against reintroducing a cross-machine instant comparison",
    () => {
      // THE ACTUAL PROOF of "a box whose clock is behind/ahead produces
      // neither a false PASS nor a false FAIL": there is no wall-clock
      // input through which skew COULD enter this computation at all — the
      // engine only ever sees a DURATION (uptimeMs), never a boot INSTANT.
      // A prior version of this test suite asserted that property with two
      // byte-identical tests that could not (and did not) construct a
      // skewed clock, and did not break when the hazard was reintroduced —
      // caught in review. This pins the property structurally instead:
      // adding a boot-instant-shaped field to RecoveryUptimeObservation is
      // exactly the widening that would let assessReboot() start comparing
      // wall-clock instants again.
      //
      // Verified by ACTUALLY reintroducing the hazard: added an optional
      // `bootInstantMs?: number` to RecoveryUptimeObservation and made
      // assessReboot() prefer it (mirroring the review's own mutation),
      // ran `bun run typecheck`, and observed THIS directive itself fail
      // as an unused '@ts-expect-error' directive (the excess-property
      // error below no longer fires once the field legitimately exists) —
      // see the PR description for the exact transcript. Reverted; restored
      // to green.
      const withBootInstant: RecoveryUptimeObservation = {
        __brand: "recovery-uptime",
        outcome: "observed",
        uptimeMs: 1000,
        note: null,
        // @ts-expect-error — RecoveryUptimeObservation has no field for a wall-clock boot instant (excess
        // property check on this literal). If this line ever stops erroring, such a field has been added
        // to the type, and this directive itself becomes an "unused @ts-expect-error" compile error — the
        // pin this test exists to provide.
        bootInstantMs: SINCE,
      };
      void withBootInstant;
    },
  );

  test("named test 3: a plug that flickered without the box restarting FAILS the reboot check", () => {
    // "Flickered" means power was cut and restored but the box's own
    // process never actually died/restarted — its uptime duration is
    // therefore STILL >= the elapsed time since the cut, identical in
    // shape to "never rebooted at all." This is exactly what catches the
    // cycle verb silently no-opping (src/recovery.ts's own comment).
    const result = evaluateRecovery(recoveredInput({ uptime: uptime({ uptimeMs: ELAPSED + 60_000 }) }));
    expect(result.checks.reboot).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("a reading that could not be parsed is COULD-NOT-LOOK, never a pass or a fail", () => {
    const result = evaluateRecovery(recoveredInput({ uptime: uptime({ outcome: "error", uptimeMs: null, note: "could not parse" }) }));
    expect(result.checks.reboot).toBe("could-not-look");
    expect(result.verdict).toBe(RecoveryVerdict.Inconclusive);
  });
});

describe("evaluateRecovery — plug/control-plane liveness (named tests 4/5)", () => {
  test("named test 4: a healthy, online, powered liveness reading contributes nothing — construct box-gone, assert NOT_RECOVERED", () => {
    // There is no field on RecoveryInput a plug-liveness reading could ever
    // occupy (see named test 5 below for the compile-time half of this
    // proof) — this test constructs the box-is-gone case (silence on every
    // configured check, with the local-connectivity control healthy so the
    // silence is unconfounded) and asserts the verdict reflects that,
    // exactly as it would with or without a hypothetical "perfect" plug
    // reading, because no such reading can ever reach this function.
    const gone = recoveredInput({
      reachability: [directPath({ name: "ssh", outcome: "dead" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
      uptime: uptime({ outcome: "error", uptimeMs: null, note: "ssh never answered" }),
    });
    const result = evaluateRecovery(gone);
    expect(result.verdict).not.toBe(RecoveryVerdict.Recovered);
    expect(result.checks.reachability).toBe("fail");
  });

  test("named test 5: a PlugLivenessReading is not assignable to RecoveryInput.reachability — a compile-time property", () => {
    const reading: PlugLivenessReading = { __brand: "recovery-plug-liveness", online: true, note: null };
    // @ts-expect-error — PlugLivenessReading's shape (and its __brand) is deliberately incompatible
    // with RecoveryDirectPathObservation[]; this line existing and needing the suppression IS the
    // proof that a liveness-only reading can never enter this evidence collection. Verified by
    // temporarily removing this directive and observing `bun run typecheck` fail with TS2322/TS2345
    // (see the PR description for the exact error observed), then restoring it.
    const reachability: RecoveryDirectPathObservation[] = [reading];
    void reachability;
  });

  test("named test 5b: a PlugLivenessReading is not assignable to RecoveryInput.instruments either", () => {
    const reading: PlugLivenessReading = { __brand: "recovery-plug-liveness", online: "unknown", note: null };
    // @ts-expect-error — same structural guarantee as above, for the instruments collection.
    const instruments: RecoveryInstrumentObservation[] = [reading];
    void instruments;
  });
});

describe("evaluateRecovery — fleet-pane audit and FLEET_HALF_RESTORED (named test 6)", () => {
  test("named test 6: agent processes present but bare is a distinct verdict from RECOVERED and NOT_RECOVERED, on its own code path", () => {
    const result = evaluateRecovery(recoveredInput({ fleet: fleet({ totalCandidates: 3, flaggedCount: 1, bareCount: 2 }) }));
    expect(result.checks.fleet).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.FleetHalfRestored);
    expect(result.verdict).not.toBe(RecoveryVerdict.Recovered);
    expect(result.verdict).not.toBe(RecoveryVerdict.NotRecovered);
  });

  test("FLEET_HALF_RESTORED requires the box itself confirmed back — reachability not passing falls back to NOT_RECOVERED", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ name: "ssh", outcome: "dead" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
        fleet: fleet({ totalCandidates: 3, flaggedCount: 1, bareCount: 2 }),
      }),
    );
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("a failure of the box itself (daemon unhealthy) outranks the fleet's bare shape — plain NOT_RECOVERED", () => {
    const result = evaluateRecovery(
      recoveredInput({
        daemon: daemon({ outcome: "unhealthy", note: "inactive" }),
        fleet: fleet({ totalCandidates: 3, flaggedCount: 1, bareCount: 2 }),
      }),
    );
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("zero agent processes found is its own affirmative failure — \"the fleet did not come back\", not FLEET_HALF_RESTORED", () => {
    const result = evaluateRecovery(recoveredInput({ fleet: fleet({ totalCandidates: 0, flaggedCount: 0, bareCount: 0 }) }));
    expect(result.checks.fleet).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("could not enumerate at all (error/timeout): could-not-look, never a fail and never a pass", () => {
    const errored = evaluateRecovery(recoveredInput({ fleet: fleet({ outcome: "error", totalCandidates: null, flaggedCount: null, bareCount: null, note: "ssh failed" }) }));
    expect(errored.checks.fleet).toBe("could-not-look");
    const timedOut = evaluateRecovery(recoveredInput({ fleet: fleet({ outcome: "timeout", totalCandidates: null, flaggedCount: null, bareCount: null, note: "timed out" }) }));
    expect(timedOut.checks.fleet).toBe("could-not-look");
  });

  test("the denominator is always reported alongside the bare count", () => {
    const result = evaluateRecovery(recoveredInput({ fleet: fleet({ totalCandidates: 5, flaggedCount: 3, bareCount: 2 }) }));
    expect(result.reasons.some((r) => r.includes("5 candidate agent process(es) found") && r.includes("2 bare"))).toBe(true);
  });
});

describe("evaluateRecovery — daemon check (named test 7)", () => {
  test("named test 7: could-not-look is never reported healthy and never unhealthy", () => {
    const errored = evaluateRecovery(recoveredInput({ daemon: daemon({ outcome: "error", note: "ssh failed" }) }));
    expect(errored.checks.daemon).toBe("could-not-look");
  });

  test('named test 7: "pointed at nothing" is distinct from "found and not running"', () => {
    const pointedAtNothing = evaluateRecovery(
      recoveredInput({ daemon: daemon({ outcome: "pointed-at-nothing", note: "LoadState=not-found" }) }),
    );
    expect(pointedAtNothing.checks.daemon).toBe("could-not-look");
    expect(pointedAtNothing.verdict).toBe(RecoveryVerdict.Inconclusive);

    const unhealthy = evaluateRecovery(recoveredInput({ daemon: daemon({ outcome: "unhealthy", note: "ActiveState=inactive" }) }));
    expect(unhealthy.checks.daemon).toBe("fail");
    expect(unhealthy.verdict).toBe(RecoveryVerdict.NotRecovered);

    // The two must never collapse to the same CheckOutcome.
    expect(pointedAtNothing.checks.daemon).not.toBe(unhealthy.checks.daemon);
  });
});

describe("evaluateRecovery — no check's pass is inferred from another's (named test 8)", () => {
  test("an unreachable box is never \"rebooted successfully\" on the strength of another check passing", () => {
    // reachability is confounded silence (could-not-look); the reboot check
    // has its OWN independent input (not-configured here) and must not
    // borrow a pass from anywhere else.
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [
          directPath({ name: "ssh", outcome: "dead" }),
          directPath({ name: "tunnel-ping", outcome: "dead" }),
        ],
        localControl: localControl({ outcome: "unhealthy", note: "no reply" }),
        uptime: uptime({ outcome: "not-configured", uptimeMs: null, note: "no ssh host" }),
      }),
    );
    expect(result.checks.reachability).toBe("could-not-look");
    expect(result.checks.reboot).toBe("not-configured");
    expect(result.verdict).not.toBe(RecoveryVerdict.Recovered);
  });
});

describe("evaluateRecovery — outside instruments (named tests 9/10)", () => {
  test("named test 9: outside instruments still silent does not read as recovered even when ssh returned", () => {
    const result = evaluateRecovery(
      recoveredInput({
        instruments: [
          instrument({ name: "jira-activity", lastSeenAt: SINCE - 5000 }),
          instrument({ name: "github-activity", lastSeenAt: SINCE - 5000 }),
        ],
      }),
    );
    expect(result.checks.reachability).toBe("pass"); // ssh returned
    expect(result.checks.instruments).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("named test 10: an instrument whose last activity predates the reference instant does NOT count as resumed", () => {
    const result = evaluateRecovery(
      recoveredInput({
        instruments: [
          instrument({ name: "jira-activity", lastSeenAt: SINCE - 1 }), // one tick before the cut
          instrument({ name: "github-activity", lastSeenAt: SINCE - 5000 }),
        ],
      }),
    );
    expect(result.checks.instruments).toBe("fail");
  });

  test("every configured instrument unreadable, none resumed: could-not-look, not a fail", () => {
    const result = evaluateRecovery(
      recoveredInput({
        instruments: [
          instrument({ name: "jira-activity", outcome: "error", lastSeenAt: null, note: "timed out" }),
          instrument({ name: "github-activity", outcome: "timeout", lastSeenAt: null, note: "timed out" }),
        ],
      }),
    );
    expect(result.checks.instruments).toBe("could-not-look");
  });

  test("at least one configured instrument resuming (activity AFTER the cut) is enough to pass", () => {
    const result = evaluateRecovery(
      recoveredInput({
        instruments: [
          instrument({ name: "jira-activity", lastSeenAt: SINCE + 1 }), // one tick after the cut
          instrument({ name: "github-activity", outcome: "error", lastSeenAt: null, note: "timed out" }),
        ],
      }),
    );
    expect(result.checks.instruments).toBe("pass");
  });
});

describe("evaluateRecovery — the local-connectivity gate on silence (named test 11)", () => {
  test("NOT_RECOVERED resting only on silence, with the control unhealthy, is INCONCLUSIVE instead", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ name: "ssh", outcome: "dead" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
        localControl: localControl({ outcome: "unhealthy", note: "no reply" }),
      }),
    );
    expect(result.checks.reachability).toBe("could-not-look");
    expect(result.verdict).toBe(RecoveryVerdict.Inconclusive);
  });

  test("NOT_RECOVERED resting only on silence, with the control unread (error), is INCONCLUSIVE instead", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ name: "ssh", outcome: "unconfirmed" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
        localControl: localControl({ outcome: "error", note: "probe itself failed" }),
      }),
    );
    expect(result.checks.reachability).toBe("could-not-look");
    expect(result.verdict).toBe(RecoveryVerdict.Inconclusive);
  });

  test("silence WITH a healthy control is an affirmative failure — NOT_RECOVERED", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ name: "ssh", outcome: "dead" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
        localControl: localControl({ outcome: "healthy" }),
      }),
    );
    expect(result.checks.reachability).toBe("fail");
    expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
  });

  test("an affirmative uptime-says-never-rebooted stays NOT_RECOVERED whatever the local-connectivity control did", () => {
    for (const controlOutcome of ["healthy", "unhealthy", "error", "timeout"] as const) {
      const result = evaluateRecovery(
        recoveredInput({
          uptime: uptime({ uptimeMs: ELAPSED + 1 }),
          localControl: localControl({ outcome: controlOutcome }),
        }),
      );
      expect(result.checks.reboot).toBe("fail");
      expect(result.verdict).toBe(RecoveryVerdict.NotRecovered);
    }
  });

  test("an alive direct path passes reachability regardless of the local-connectivity control", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ name: "ssh", outcome: "alive" }), directPath({ name: "tunnel-ping", outcome: "dead" })],
        localControl: localControl({ outcome: "unhealthy" }),
      }),
    );
    expect(result.checks.reachability).toBe("pass");
  });
});

describe("evaluateRecovery — RECOVERED reachability (named test 12)", () => {
  test("any single check unconfigured makes RECOVERED unreachable", () => {
    const configs: Partial<RecoveryInput>[] = [
      { reachability: [directPath({ outcome: "not-configured" }), directPath({ name: "tunnel-ping", outcome: "not-configured" })] },
      { uptime: uptime({ outcome: "not-configured", uptimeMs: null, note: "no ssh host" }) },
      { daemon: daemon({ outcome: "not-configured", unit: null, scope: null, note: "no unit/scope" }) },
      {
        instruments: [
          instrument({ name: "jira-activity", outcome: "not-configured", lastSeenAt: null, note: "no target" }),
          instrument({ name: "github-activity", outcome: "not-configured", lastSeenAt: null, note: "no target" }),
        ],
      },
      { fleet: fleet({ outcome: "not-configured", totalCandidates: null, flaggedCount: null, bareCount: null, note: "no config" }) },
    ];
    for (const override of configs) {
      const result = evaluateRecovery(recoveredInput(override));
      expect(result.verdict).not.toBe(RecoveryVerdict.Recovered);
    }
  });

  test("any single check unreadable (could-not-look) makes RECOVERED unreachable", () => {
    const result = evaluateRecovery(recoveredInput({ daemon: daemon({ outcome: "timeout", note: "timed out" }) }));
    expect(result.verdict).not.toBe(RecoveryVerdict.Recovered);
  });
});

describe("evaluateRecovery — UNCONFIGURED vs INCONCLUSIVE (named test 13)", () => {
  test("a run whose only gaps are unconfigured checks reports UNCONFIGURED, its own code, not could-not-look", () => {
    const result = evaluateRecovery(
      recoveredInput({
        daemon: daemon({ outcome: "not-configured", unit: null, scope: null, note: "no unit/scope" }),
        fleet: fleet({ outcome: "not-configured", totalCandidates: null, flaggedCount: null, bareCount: null, note: "no config" }),
      }),
    );
    expect(result.verdict).toBe(RecoveryVerdict.Unconfigured);
  });

  test("a run with BOTH an unconfigured check and a genuine could-not-look reports INCONCLUSIVE", () => {
    const result = evaluateRecovery(
      recoveredInput({
        daemon: daemon({ outcome: "not-configured", unit: null, scope: null, note: "no unit/scope" }),
        uptime: uptime({ outcome: "timeout", uptimeMs: null, note: "timed out" }),
      }),
    );
    expect(result.verdict).toBe(RecoveryVerdict.Inconclusive);
  });

  test("a totally fresh, nothing-configured run reports UNCONFIGURED", () => {
    const result = evaluateRecovery(
      recoveredInput({
        reachability: [directPath({ outcome: "not-configured" }), directPath({ name: "tunnel-ping", outcome: "not-configured" })],
        uptime: uptime({ outcome: "not-configured", uptimeMs: null, note: "no ssh host" }),
        daemon: daemon({ outcome: "not-configured", unit: null, scope: null, note: "no unit/scope" }),
        instruments: [
          instrument({ name: "jira-activity", outcome: "not-configured", lastSeenAt: null, note: "no target" }),
          instrument({ name: "github-activity", outcome: "not-configured", lastSeenAt: null, note: "no target" }),
        ],
        fleet: fleet({ outcome: "not-configured", totalCandidates: null, flaggedCount: null, bareCount: null, note: "no config" }),
      }),
    );
    expect(result.verdict).toBe(RecoveryVerdict.Unconfigured);
  });
});

describe("evaluateRecovery — elapsedMs", () => {
  test("elapsedMs is now - since, reported on every result", () => {
    const result = evaluateRecovery(recoveredInput());
    expect(result.elapsedMs).toBe(ELAPSED);
  });
});
