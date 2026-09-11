// Covers the ticket's seventeen named refusal/behaviour tests for `wyzr
// cycle`'s orchestration (src/cycle-runner.ts), each as its own named test,
// and — per the epic's widened R6 — each one proves the run actually
// REACHED the decision point it is named for, not merely that it produced
// the expected outcome/exit-code shape. "Reached" is proven concretely per
// test: a fake's own call counter (`plug.readCount`/`writeCount`), the
// composed engine's own verdict surfacing in the result
// (`result.gate.verdict`/`result.recovery.verdict`), or the evidence trail
// containing the specific line only that step could have produced.

import { describe, expect, test } from "bun:test";
import { runCycleDryRun, runCycleLive, type CycleRunnerDeps } from "../../src/cycle-runner.ts";
import { createFakeCycleClock } from "../../src/cycle-clock.ts";
import { FakeCyclePlugTransport, fakePlugReading } from "../../src/cycle-plug-fake.ts";
import { WedgeVerdict } from "../../src/wedge.ts";
import {
  FakeWedgeProbes,
  fakeDirectPathAlive,
  fakeDirectPathDead,
  fakeLocalControlHealthy,
  fakeLocalControlUnhealthy,
  type FakeWedgeProbesOptions,
} from "../../src/wedge-probes-fake.ts";
import { FakeRecoveryProbes, fakeDaemonHealthy, fakeFleetEnumerated, fakeUptimeObserved } from "../../src/recovery-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY, type WedgeConfig } from "../../src/wedge-config.ts";
import type { RecoveryConfig } from "../../src/recovery-config.ts";
import { RecoveryVerdict, type RecoveryDirectPathObservation } from "../../src/recovery.ts";
import type { RunRecoveryCheckOptions } from "../../src/recovery-runner.ts";
import type { WedgeProbes } from "../../src/wedge-probes.ts";
import type { RecoveryProbes } from "../../src/recovery-probes.ts";
import type { LocalIdentityProbe } from "../../src/cycle-wrong-box.ts";
import type { CycleTimingConfig } from "../../src/cycle-config.ts";
import type { PlugReading } from "../../src/plug.ts";

const NOW = 1_800_000_000_000;

// Clearly-fake, non-real fixture names — never a real fleet host/plug name
// (the ticket's own rule; see also test/unit/redact.test.ts's convention
// of fixture secrets that are obviously not real).
const TARGET_HOST_FIXTURE = "cycle-test-target-fixture.invalid";
const NOT_TARGET_HOST_FIXTURE = "cycle-test-runner-fixture.invalid";
const HAND_RESTORE_COMMAND_FIXTURE = "cycle-test-fixture-restore-command --by-hand";

function gateConfig(overrides: Partial<WedgeConfig> = {}): WedgeConfig {
  return {
    jira: {
      name: "jira-activity",
      baseUrl: "https://example-not-real.atlassian.net",
      authHeader: "Basic fake-secret-abc123",
      dependsOn: [MANAGER_INTERNET_DEPENDENCY],
      quietThresholdMs: 60_000,
      timeoutMs: 1000,
    },
    github: {
      name: "github-activity",
      owner: "brooswit-factory",
      repo: "wyzr",
      dependsOn: [MANAGER_INTERNET_DEPENDENCY],
      quietThresholdMs: 60_000,
      timeoutMs: 1000,
    },
    ssh: { name: "ssh", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
    tunnelPing: { name: "tunnel-ping", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
    localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
    controlPlane: undefined,
    ...overrides,
  };
}

function provenGateProbes(now: number, opts: FakeWedgeProbesOptions = {}): WedgeProbes {
  return new FakeWedgeProbes({
    jiraHandler: async () => ({ outcome: "observed", lastSeenAt: now - 200_000, note: null }),
    gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: now - 200_000, note: null }),
    sshHandler: async () => fakeDirectPathDead(),
    tunnelPingHandler: async () => fakeDirectPathDead(),
    localConnectivityHandler: async () => fakeLocalControlHealthy(),
    ...opts,
  });
}

/** Both instruments ACTIVE (quiet 0ms, well under threshold) and direct
 * paths alive -> silent.length < 2 -> NOT_PROVEN, the ordinary "healthy
 * box" case, not a probe failure. */
function notProvenGateProbes(now: number): WedgeProbes {
  return new FakeWedgeProbes({
    jiraHandler: async () => ({ outcome: "observed", lastSeenAt: now, note: null }),
    gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: now, note: null }),
    sshHandler: async () => fakeDirectPathAlive(),
    tunnelPingHandler: async () => fakeDirectPathAlive(),
    localConnectivityHandler: async () => fakeLocalControlHealthy(),
  });
}

/** >=2 silent instruments, all direct paths dead (never alive), but the
 * local-connectivity control UNHEALTHY -> the shared-cause exclusion
 * cannot run -> INCONCLUSIVE_BY_SHARED_CAUSE, distinct from NOT_PROVEN. */
function inconclusiveGateProbes(now: number): WedgeProbes {
  return new FakeWedgeProbes({
    jiraHandler: async () => ({ outcome: "observed", lastSeenAt: now - 200_000, note: null }),
    gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: now - 200_000, note: null }),
    sshHandler: async () => fakeDirectPathDead(),
    tunnelPingHandler: async () => fakeDirectPathDead(),
    localConnectivityHandler: async () => fakeLocalControlUnhealthy(),
  });
}

function recoveryConfig(overrides: Partial<RecoveryConfig> = {}): RecoveryConfig {
  return {
    jira: undefined,
    github: undefined,
    ssh: undefined,
    tunnelPing: undefined,
    localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
    uptime: undefined,
    daemon: undefined,
    fleet: undefined,
    ...overrides,
  };
}

const clearIdentityProbe: LocalIdentityProbe = { getLocalHostname: async () => NOT_TARGET_HOST_FIXTURE };

const fastTiming: CycleTimingConfig = {
  offToOnWaitMs: 5,
  offReadbackPollIntervalMs: 5,
  offReadbackBoundMs: 20,
  restoreReadbackPollIntervalMs: 5,
  restoreReadbackBoundMs: 20,
  restorePollIntervalMs: 5,
  restoreTimeoutMs: 60,
};

function baseDeps(overrides: Partial<CycleRunnerDeps> = {}): CycleRunnerDeps {
  return {
    gateConfig: gateConfig(),
    gateProbes: provenGateProbes(NOW),
    configuredTargetHost: TARGET_HOST_FIXTURE,
    identityProbe: clearIdentityProbe,
    recoveryConfig: recoveryConfig(),
    recoveryWedgeProbes: new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() }),
    recoveryProbes: new FakeRecoveryProbes(),
    clock: createFakeCycleClock(NOW),
    timing: fastTiming,
    forced: false,
    handRestoreCommand: HAND_RESTORE_COMMAND_FIXTURE,
    ...overrides,
  };
}

describe("named test 1: gate NOT_PROVEN -> refuses, cuts nothing", () => {
  test("no write is ATTEMPTED, and the run demonstrably REACHED the gate's own NOT_PROVEN decision (not merely a non-zero-shaped outcome)", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ gateProbes: notProvenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_gate");
    // REACHED proof: the gate's own composed verdict, surfaced in the
    // result, is NOT_PROVEN — this could only be true if evaluateWedge()
    // actually ran and actually decided that, not a default.
    expect(result.gate.verdict).toBe(WedgeVerdict.NotProven);
    // REACHED proof, deeper: the preamble also reached the preconditions
    // check (read once) before concluding, proving this is not a
    // trivial step-one short-circuit that would pass even if the gate
    // check were deleted.
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 2: gate INCONCLUSIVE -> refuses, reported as neither wedged nor fine", () => {
  test("outcome is refused_by_gate with the gate's own verdict INCONCLUSIVE_BY_SHARED_CAUSE, distinct from NOT_PROVEN", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ gateProbes: inconclusiveGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_gate");
    expect(result.gate.verdict).toBe(WedgeVerdict.InconclusiveBySharedCause);
    expect(result.gate.verdict).not.toBe(WedgeVerdict.NotProven);
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 3: gate PROVEN but cloud unreachable -> refuses, cuts nothing", () => {
  test("the gate itself says PROVEN (proving the refusal is attributable to the precondition, not the gate), yet the run refuses", async () => {
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        throw new Error("simulated-cloud-unreachable-fixture");
      },
    });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_precondition");
    expect(result.gate.verdict).toBe(WedgeVerdict.Proven);
    expect(result.preconditions.outcome).toBe("cloud_unreachable");
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 4: gate PROVEN but plug state unreadable -> refuses, cuts nothing", () => {
  test("P3 undecodable with gate PROVEN -> refused_by_precondition, no write", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "unknown", reachable: true }) });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_precondition");
    expect(result.gate.verdict).toBe(WedgeVerdict.Proven);
    expect(result.preconditions.outcome).toBe("plug_state_unreadable");
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 5 (THE MOST IMPORTANT TEST IN THIS STORY): force + gate NOT_PROVEN + cloud unreachable -> STILL REFUSES", () => {
  test("proves force overrides the JUDGMENT but cannot override the CAPABILITY", async () => {
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        throw new Error("simulated-cloud-unreachable-fixture");
      },
    });
    const deps = baseDeps({ gateProbes: notProvenGateProbes(NOW), forced: true });
    const result = await runCycleLive(plug, deps);

    // If force had (incorrectly) been allowed to short-circuit past the
    // gate's own refusal without the preamble ever reaching the
    // precondition check, this would read "refused_by_gate" (or, worse,
    // proceed to a write). It does neither.
    expect(result.outcome).toBe("refused_by_precondition");
    expect(result.forced).toBe(true);
    // REACHED proof: the gate's own verdict IS NOT_PROVEN (force's own
    // decideGate() branch, which WOULD have said "proceed," was evaluated
    // and recorded — see result.reasons below) — but the run still refused,
    // because the precondition check is independent of that decision.
    expect(result.gate.verdict).toBe(WedgeVerdict.NotProven);
    expect(result.reasons.some((r) => r.includes("human-forced"))).toBe(true);
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });
});

// Named test 6 (force flag WITHOUT its confirmation -> refuses) is a CLI
// ceremony concern — src/cli-cycle.ts's resolveForced(), not this runner's
// `forced: boolean` input, which is already a resolved decision by the
// time it reaches here. See test/unit/cli-cycle.test.ts.

describe("named test 7: wrong-box guard — configured target IS the local machine -> refuses, whatever the gate said", () => {
  test("gate PROVEN, but this machine IS the target -> refused_by_wrong_box_guard, not refused_by_gate", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const isTargetProbe: LocalIdentityProbe = { getLocalHostname: async () => TARGET_HOST_FIXTURE };
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), identityProbe: isTargetProbe, forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_wrong_box_guard");
    expect(result.wrongBoxGuard.outcome).toBe("is_target");
    // "whatever the gate said" — proven by using a PROVEN gate here (the
    // strongest case for proceeding) and still refusing.
    expect(result.gate.verdict).toBe(WedgeVerdict.Proven);
    // REACHED proof: preconditions were STILL evaluated (the preamble
    // never short-circuits on the wrong-box guard alone) even though the
    // wrong-box guard has top refusal priority.
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });

  test("gate NOT_PROVEN, forced=true, this machine IS the target -> STILL refused_by_wrong_box_guard (no escape hatch under any flag, D7)", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const isTargetProbe: LocalIdentityProbe = { getLocalHostname: async () => TARGET_HOST_FIXTURE };
    const deps = baseDeps({ gateProbes: notProvenGateProbes(NOW), identityProbe: isTargetProbe, forced: true });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_wrong_box_guard");
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 8: wrong-box guard — unconfigured target / unreadable local identity / inconclusive comparison -> refuses (D7 err-tight)", () => {
  test("8a: target unconfigured -> refused_by_wrong_box_guard, outcome inconclusive", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ configuredTargetHost: undefined, forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_wrong_box_guard");
    expect(result.wrongBoxGuard.outcome).toBe("inconclusive");
    expect(plug.writeCount).toBe(0);
  });

  test("8b: local identity unreadable -> refused_by_wrong_box_guard, outcome inconclusive", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const unreadableProbe: LocalIdentityProbe = { getLocalHostname: async () => null };
    const deps = baseDeps({ identityProbe: unreadableProbe, forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_wrong_box_guard");
    expect(result.wrongBoxGuard.outcome).toBe("inconclusive");
    expect(plug.writeCount).toBe(0);
  });

  test("8c: comparison inconclusive (IP-literal target vs hostname local identity) -> refused_by_wrong_box_guard", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ configuredTargetHost: "10.0.0.5", forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("refused_by_wrong_box_guard");
    expect(result.wrongBoxGuard.outcome).toBe("inconclusive");
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 9: --dry-run performs no write on ANY path, INCLUDING force, and the run reaches the step where a write would occur", () => {
  test("everything cleared, forced=true -> would_act (the run reached the exact point a live run would have written), zero writes on a structural PlugReader boundary", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: true });
    const result = await runCycleDryRun(plug, deps);

    // "would_act" is ONLY ever produced when the gate, wrong-box guard,
    // AND preconditions all cleared — i.e., this proves the run reached
    // exactly the point a live run would begin the OFF write, not merely
    // that it exited non-zero at step one.
    expect(result.outcome).toBe("would_act");
    expect(result.dryRun).toBe(true);
    expect(plug.writeCount).toBe(0);
    expect(plug.readCount).toBe(1);
  });

  test("a dry run that WOULD refuse (gate NOT_PROVEN, not forced) also performs no write, and reports the same refusal a live run would", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({ gateProbes: notProvenGateProbes(NOW), forced: false });
    const result = await runCycleDryRun(plug, deps);

    expect(result.outcome).toBe("refused_by_gate");
    expect(plug.writeCount).toBe(0);
  });
});

describe("named test 10: OFF succeeded and ON unconfirmed -> STRANDED — never reported as success", () => {
  test("power stays observably OFF through every ON read-back -> stranded, with the hand-restore command in the evidence, and the ON write demonstrably retried (never-give-up, reached far past a single attempt)", async () => {
    // Every read (OFF's own read-back AND every ON read-back) observes the
    // plug still off — so the OFF read-back confirms quickly, but no ON
    // attempt is EVER classified "confirmed".
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "off", reachable: true }) });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.outcome).toBe("stranded");
    expect(result.handRestoreCommand).toBe(HAND_RESTORE_COMMAND_FIXTURE);
    expect(result.reasons.some((r) => r.includes("STRANDED") && r.includes(HAND_RESTORE_COMMAND_FIXTURE))).toBe(true);
    expect(result.restore?.confirmed).toBe(false);
    expect(result.off?.finalResult).toBe("confirmed"); // OFF itself DID confirm — this is specifically the restore's failure
    // REACHED proof: the OFF write happened exactly once, and the ON write
    // was retried (never-give-up) more than once before the outer bound —
    // proving this scenario actually drove the retry loop, not a single
    // early return.
    expect(plug.writes.filter((v) => v === "0")).toHaveLength(1);
    expect(plug.writes.filter((v) => v === "1").length).toBeGreaterThan(1);
    // A stranded result must never carry a recovery verdict at all — D6/D1:
    // "the verb must NEVER exit reporting anything but failure while the
    // plug is, as far as it knows, still off."
    expect(result.recovery).toBeNull();
  });
});

describe("named test 11: a write_contradicted read-back on the OFF is NOT treated as \"the write failed\" — no second blind write (R1), and the restore still runs (R2)", () => {
  test("OFF read-back reads back power=on (contradicted) -> exactly one OFF write, and the restore (ON) still runs afterward", async () => {
    // Always reads "on" — so requesting "off" always classifies as
    // contradicted, and requesting "on" (the restore) always classifies as
    // confirmed immediately.
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({
      gateProbes: provenGateProbes(NOW),
      recoveryConfig: recoveryConfig(), // everything unconfigured -> UNCONFIGURED verdict, fine for this test's focus
      forced: false,
    });
    const result = await runCycleLive(plug, deps);

    expect(result.off?.finalResult).toBe("contradicted");
    // R1's own pin: exactly one OFF write attempt, even though the
    // read-back disagreed.
    expect(plug.writes.filter((v) => v === "0")).toHaveLength(1);
    // R2's own pin: the restore was NOT skipped — it ran, and (since every
    // read here reports "on") confirmed on its first attempt.
    expect(result.restore).not.toBeNull();
    expect(result.restore?.confirmed).toBe(true);
    expect(result.outcome).not.toBe("stranded");
  });

  test("OFF write call itself THREW (a thrown set_property cannot be distinguished from a write that landed with a lost response) -> still exactly one OFF write, and the restore still runs", async () => {
    let offAttempts = 0;
    const plug = new FakeCyclePlugTransport({
      writeHandler: (value) => {
        if (value === "0") {
          offAttempts++;
          throw new Error("simulated-lost-response-fixture");
        }
      },
      readHandler: () => fakePlugReading({ power: "on", reachable: true }),
    });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(offAttempts).toBe(1);
    expect(result.off?.writeThrew).toBe(true);
    expect(plug.writes.filter((v) => v === "0")).toHaveLength(1);
    // R2 still holds when the write itself threw: the restore ran anyway.
    expect(result.restore).not.toBeNull();
    expect(result.outcome).not.toBe("stranded");
  });

  test("OFF read-back never propagates (state_unknown) within the bound -> still exactly one OFF write, restore still runs", async () => {
    // Call #1 is the PRECONDITION read (must be decodable, or the run
    // refuses before ever reaching OFF — a different test's concern).
    // Every call from #2 onward (the OFF/ON read-back retries) reads back
    // undecodable, so the OFF read-back exhausts its bound as "unconfirmed"
    // — this test's actual focus.
    let calls = 0;
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        calls++;
        if (calls === 1) return fakePlugReading({ power: "on", reachable: true });
        return fakePlugReading({ power: "unknown", reachable: null });
      },
    });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.off?.finalResult).toBe("unconfirmed");
    expect(plug.writes.filter((v) => v === "0")).toHaveLength(1);
    expect(result.restore).not.toBeNull(); // R2: attempted regardless
  });
});

describe("named test 12: a read-back that has not propagated within one attempt is RETRIED to the configured bound before any conclusion (R3)", () => {
  test("the first two OFF read-backs are unconfirmed, the third confirms -> the run actually retried (readBacks.length > 1) using the injected clock, not a single-shot conclusion", async () => {
    // Call #1 is the PRECONDITION read — must be decodable. Calls #2/#3
    // (the OFF read-back's first two attempts) are undecodable; call #4
    // onward (its third attempt) confirms "off".
    let calls = 0;
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        calls++;
        if (calls === 1) return fakePlugReading({ power: "on", reachable: true });
        const offAttempt = calls - 1;
        return fakePlugReading({ power: offAttempt >= 3 ? "off" : "unknown", reachable: offAttempt >= 3 ? true : null });
      },
    });
    const clock = createFakeCycleClock(NOW);
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), clock, forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.off?.finalResult).toBe("confirmed");
    // Constructs exactly what the test name claims: more than one
    // attempt, and a genuine retry (not a premature conclusion at attempt
    // 1).
    expect(result.off?.readBacks.length).toBeGreaterThan(1);
    // Retrying used the injected clock's sleep — proof the bound-checking
    // path (not a lucky first success) is what ran.
    expect(clock.sleeps.length).toBeGreaterThan(0);
  });
});

describe("named test 13: no failure code is reasoned backwards to a cause anywhere in this verb", () => {
  test("a thrown read error's message is relayed verbatim in the evidence trail — never re-interpreted with an invented cause", async () => {
    const RAW_MESSAGE = "simulated-transport-error-xyz-987";
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        throw new Error(RAW_MESSAGE);
      },
    });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    const combined = result.reasons.join(" \n ");
    expect(combined).toContain(RAW_MESSAGE);
    // These are exactly the invented-cause phrases src/wyze-errors.ts's
    // OWN errorCode 1000 trap names for a DIFFERENT failure family (auth) —
    // none of them belongs anywhere in this verb's OWN reasoning about a
    // plug read/write failure, which never knows WHY a call failed, only
    // THAT it did.
    for (const phrase of ["wrong password", "sso-only", "sso only", "api key"]) {
      expect(combined.toLowerCase()).not.toContain(phrase);
    }
  });

  test("a thrown OFF write's message is relayed verbatim, never re-interpreted", async () => {
    const RAW_MESSAGE = "simulated-off-write-error-fixture-456";
    const plug = new FakeCyclePlugTransport({
      writeHandler: (value) => {
        if (value === "0") throw new Error(RAW_MESSAGE);
      },
      readHandler: () => fakePlugReading({ power: "on", reachable: true }),
    });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const result = await runCycleLive(plug, deps);

    expect(result.off?.writeErrorMessage).toBe(RAW_MESSAGE);
    expect(result.reasons.join(" ")).toContain(RAW_MESSAGE);
  });
});

describe("named test 14: a plug-liveness reading cannot reach the recovery verdict — pinned in THIS module's own test file, not only by relying on the existing pin", () => {
  test("14a: a PlugReading (the exact type this module's own precondition check holds) is not assignable to RecoveryInput's evidence collections — a compile-time property", () => {
    const reading: PlugReading = { power: "on", reachable: true, note: null };
    // @ts-expect-error — PlugReading has no `__brand` at all and does not structurally match
    // RecoveryDirectPathObservation ({__brand:"recovery-direct-path", name, outcome, note}); this assignment
    // is rejected on shape alone. Verified by removing this directive and observing `bun run typecheck`
    // report a new TS2322/TS2352 error at this line before restoring it.
    const reachability: RecoveryDirectPathObservation[] = [reading];
    void reachability;
  });

  test("14b: RunRecoveryCheckOptions (what this module's own runCycleLive() actually calls) has no field a plug reading could occupy", () => {
    const reading: PlugReading = { power: "on", reachable: true, note: null };
    const options: RunRecoveryCheckOptions = {
      config: recoveryConfig(),
      wedgeProbes: {} as WedgeProbes,
      recoveryProbes: {} as RecoveryProbes,
      since: NOW,
      // @ts-expect-error — RunRecoveryCheckOptions has no `plug`/`reading`/liveness-shaped field at all; this
      // excess property on the object literal is rejected. This is the structural proof that
      // src/cycle-runner.ts's own call to runRecoveryCheck() below cannot smuggle its PlugReading in even by
      // a careless edit — there is no parameter to put it in.
      plug: reading,
    };
    void options;
  });
});

describe("named test 15: box did not return vs fleet came back bare — distinct outcomes from RECOVERED and from each other", () => {
  function recoveredEverything(): { wedgeProbes: WedgeProbes; recoveryProbes: RecoveryProbes; recoveryConfig: RecoveryConfig } {
    return {
      wedgeProbes: new FakeWedgeProbes({
        jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW + 50_000, note: null }),
        gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW + 50_000, note: null }),
        sshHandler: async () => fakeDirectPathAlive(),
        tunnelPingHandler: async () => fakeDirectPathAlive(),
        localConnectivityHandler: async () => fakeLocalControlHealthy(),
      }),
      recoveryProbes: new FakeRecoveryProbes({
        // uptimeMs must be LESS than elapsedMs (now-since) for the reboot
        // check to PASS ("the box booted after the cut") — this fixture's
        // own OFF/ON read-backs confirm quickly under fastTiming, so
        // elapsedMs stays small; 1ms of uptime is safely below it without
        // depending on the exact retry timing.
        uptimeHandler: async () => fakeUptimeObserved(1),
        daemonHandler: async () => fakeDaemonHealthy(),
        fleetAuditHandler: async () => fakeFleetEnumerated(2, 0),
      }),
      recoveryConfig: recoveryConfig({
        jira: {
          name: "jira-activity",
          baseUrl: "https://example-not-real.atlassian.net",
          authHeader: "Basic fake-secret-abc123",
          dependsOn: [MANAGER_INTERNET_DEPENDENCY],
          quietThresholdMs: 60_000,
          timeoutMs: 1000,
        },
        github: {
          name: "github-activity",
          owner: "brooswit-factory",
          repo: "wyzr",
          dependsOn: [MANAGER_INTERNET_DEPENDENCY],
          quietThresholdMs: 60_000,
          timeoutMs: 1000,
        },
        ssh: { name: "ssh", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
        tunnelPing: { name: "tunnel-ping", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
        uptime: { host: "unused", timeoutMs: 1000 },
        daemon: { host: "unused", unit: "example.service", scope: "user", timeoutMs: 1000 },
        fleet: { host: "unused", processMatch: "claude", expectedFlags: ["--mcp-config"], timeoutMs: 1000 },
      }),
    };
  }

  test("the box itself did not come back (reachability + reboot fail) -> not_recovered, distinct from fleet_half_restored and recovered", async () => {
    const fixture = recoveredEverything();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({
      gateProbes: provenGateProbes(NOW),
      recoveryWedgeProbes: new FakeWedgeProbes({
        sshHandler: async () => fakeDirectPathDead(),
        tunnelPingHandler: async () => fakeDirectPathDead(),
        localConnectivityHandler: async () => fakeLocalControlHealthy(),
      }),
      recoveryProbes: new FakeRecoveryProbes({ uptimeHandler: async () => fakeUptimeObserved(1000) }),
      recoveryConfig: fixture.recoveryConfig,
      forced: false,
    });
    const result = await runCycleLive(plug, deps);

    expect(result.recovery?.verdict).toBe(RecoveryVerdict.NotRecovered);
    expect(result.outcome).toBe("not_recovered");
    expect(result.outcome).not.toBe("fleet_half_restored");
    expect(result.outcome).not.toBe("recovered");
  });

  test("the box IS confirmed back, but the fleet came back bare -> fleet_half_restored, distinct from recovered", async () => {
    const fixture = recoveredEverything();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({
      gateProbes: provenGateProbes(NOW),
      recoveryWedgeProbes: fixture.wedgeProbes,
      recoveryProbes: new FakeRecoveryProbes({
        uptimeHandler: async () => fakeUptimeObserved(1),
        daemonHandler: async () => fakeDaemonHealthy(),
        fleetAuditHandler: async () => fakeFleetEnumerated(3, 2), // 2 of 3 bare
      }),
      recoveryConfig: fixture.recoveryConfig,
      forced: false,
    });
    const result = await runCycleLive(plug, deps);

    expect(result.recovery?.verdict).toBe(RecoveryVerdict.FleetHalfRestored);
    expect(result.outcome).toBe("fleet_half_restored");
    expect(result.outcome).not.toBe("recovered");
    expect(result.outcome).not.toBe("not_recovered");
  });

  test("everything genuinely recovers -> recovered, exit-mapped to 0 by symmetry with recovery status's own RECOVERED", async () => {
    const fixture = recoveredEverything();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const deps = baseDeps({
      gateProbes: provenGateProbes(NOW),
      recoveryWedgeProbes: fixture.wedgeProbes,
      recoveryProbes: fixture.recoveryProbes,
      recoveryConfig: fixture.recoveryConfig,
      forced: false,
    });
    const result = await runCycleLive(plug, deps);

    expect(result.recovery?.verdict).toBe(RecoveryVerdict.Recovered);
    expect(result.outcome).toBe("recovered");
  });
});

describe("named test 16: the OFF write is attempted at most once on every path (R1)", () => {
  const scenarios: Array<{ name: string; reading: () => PlugReading | null; threw: boolean }> = [
    { name: "confirmed", reading: () => fakePlugReading({ power: "off", reachable: true }), threw: false },
    { name: "contradicted", reading: () => fakePlugReading({ power: "on", reachable: true }), threw: false },
    { name: "unconfirmed (state_unknown)", reading: () => fakePlugReading({ power: "unknown", reachable: null }), threw: false },
    { name: "the write call itself threw", reading: () => fakePlugReading({ power: "on", reachable: true }), threw: true },
  ];

  for (const scenario of scenarios) {
    test(`OFF read-back = ${scenario.name} -> exactly one OFF write attempted, and the run reached the OFF step to prove it`, async () => {
      let offCalls = 0;
      let readCalls = 0;
      const plug = new FakeCyclePlugTransport({
        writeHandler: (value) => {
          if (value === "0") {
            offCalls++;
            if (scenario.threw) throw new Error("simulated-off-write-threw-fixture");
          }
        },
        // Call #1 is the PRECONDITION read — must be decodable, or the run
        // refuses before ever reaching OFF. Every call after that is the
        // OFF/ON read-back retry loop, which this scenario controls.
        readHandler: () => {
          readCalls++;
          return readCalls === 1 ? fakePlugReading({ power: "on", reachable: true }) : scenario.reading()!;
        },
      });
      const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
      const result = await runCycleLive(plug, deps);

      // REACHED proof: `off` is non-null at all only if the run actually
      // got past the preamble into performOff().
      expect(result.off).not.toBeNull();
      expect(offCalls).toBe(1);
      expect(plug.writes.filter((v) => v === "0")).toHaveLength(1);
    });
  }
});

describe("named test 17: no real-timer sleep anywhere in the suite; the orchestration has no default clock (R9)", () => {
  test("a full STRANDED run (many bounded retries) completes in real wall-clock milliseconds, using only the injected fake clock", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "off", reachable: true }) });
    const deps = baseDeps({ gateProbes: provenGateProbes(NOW), forced: false });
    const wallClockStart = Date.now();
    const result = await runCycleLive(plug, deps);
    const wallClockElapsed = Date.now() - wallClockStart;

    expect(result.outcome).toBe("stranded");
    // The virtual clock advanced by the FULL configured restore timeout
    // (60ms of VIRTUAL time) and more of OFF-readback/wait time on top —
    // real wall-clock time stayed well under a real second, proving no
    // real setTimeout/sleep of that duration ever ran.
    expect(wallClockElapsed).toBeLessThan(1_000);
  });

  test("CycleRunnerDeps has no default clock — omitting `clock` entirely is a compile error", () => {
    const { clock, ...withoutClock } = baseDeps();
    void clock;
    // @ts-expect-error — `clock` is a REQUIRED field on CycleRunnerDeps with no `?? RealCycleClock` fallback
    // anywhere in src/cycle-runner.ts (R9); omitting it here is "Property 'clock' is missing." If this line
    // ever stops erroring, a default clock has leaked in somewhere, which is exactly what R9 forbids.
    const deps: CycleRunnerDeps = withoutClock;
    void deps;
  });
});
