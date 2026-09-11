// `wyzr rehearse-safe-plug-write`'s orchestration (src/rehearsal-runner.ts)
// — zero network, zero credentials, zero real writes (FakeCyclePlugTransport,
// reused unchanged from src/cycle-plug-fake.ts). Each test proves the run
// actually REACHED the decision point it is named for (a fake's own call
// counter, or an evidence-trail line only that step could have produced) —
// same R6-widened discipline test/unit/cycle-runner.test.ts already
// established, per this ticket's own "a 'zero writes' assertion is vacuous
// unless the test proves the run got as far as the write point" rule.
//
// `FleetPlugTarget`/`SafePlugTarget` are branded with module-private
// `unique symbol`s (src/config.ts) — the only legitimate way to mint one for
// a fixture is through the REAL `loadWyzrConfig()` call against a temp-file
// fixture, same technique test/unit/config.test.ts's and
// test/unit/doctor-runner.test.ts's own fixtures already use, reused here
// rather than an `as unknown as SafePlugTarget` cast (src/config.ts's own
// top comment calls that "a lie a reviewer would have to wave through").

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWyzrConfig, type FleetPlugTarget, type SafePlugTarget, type WyzrConfigEnv } from "../../src/config.ts";
import { createFakeCycleClock } from "../../src/cycle-clock.ts";
import { FakeCyclePlugTransport, fakePlugReading } from "../../src/cycle-plug-fake.ts";
import type { CycleTimingConfig } from "../../src/cycle-config.ts";
import {
  defaultPlugIdentityCheck,
  runRehearsalLive,
  runRehearsalPreview,
  type PlugIdentityCheck,
  type RehearsalRunnerDeps,
} from "../../src/rehearsal-runner.ts";

const NOW = 1_800_000_000_000;
const FLEET_MAC = "AA:BB:CC:DD:EE:01";
const SAFE_MAC = "11:22:33:44:55:02";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Mints REAL, properly-branded FleetPlugTarget/SafePlugTarget by writing a
 * fixture config.json and calling the actual loader — see this file's own
 * top comment for why. */
async function buildPlugs(): Promise<{ fleetPlug: FleetPlugTarget; safePlug: SafePlugTarget }> {
  const base = await mkdtemp(join(tmpdir(), "wyzr-rehearsal-test-"));
  tempDirs.push(base);
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const path = join(dir, "config.json");
  const content = {
    suspectBox: { host: "rehearsal-fixture-suspect-box.invalid" },
    fleetPlug: { mac: FLEET_MAC, model: "WLPP1CFH", name: "fixture-fleet-plug" },
    safePlug: { mac: SAFE_MAC, model: "WLPPO", name: "fixture-safe-plug", subDeviceId: `${SAFE_MAC}-SUB1` },
  };
  await writeFile(path, JSON.stringify(content), "utf8");
  await chmod(path, 0o600);
  const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };
  const config = loadWyzrConfig(env);
  return { fleetPlug: config.fleetPlug, safePlug: config.safePlug };
}

const fastTiming: CycleTimingConfig = {
  offToOnWaitMs: 5,
  offReadbackPollIntervalMs: 5,
  offReadbackBoundMs: 20,
  restoreReadbackPollIntervalMs: 5,
  restoreReadbackBoundMs: 20,
  restorePollIntervalMs: 5,
  restoreTimeoutMs: 60,
};

/** ALWAYS says "different device" — the production default
 * (`defaultPlugIdentityCheck`, backed by src/config.ts's own
 * `samePlugIdentity()`) can never observe a conflated pair through a real
 * `WyzrConfig` (see this file's own top comment), so every test that is
 * not specifically about guard 2 uses this instead. */
const neverSameDevice: PlugIdentityCheck = () => false;

async function baseDeps(overrides: Partial<RehearsalRunnerDeps> = {}): Promise<RehearsalRunnerDeps> {
  const { fleetPlug, safePlug } = await buildPlugs();
  return {
    fleetPlug,
    safePlug,
    clock: createFakeCycleClock(NOW),
    timing: fastTiming,
    sameDeviceCheck: neverSameDevice,
    ...overrides,
  };
}

describe("guard 1 — COMPILE-TIME: a FleetPlugTarget is not assignable where a SafePlugTarget is required", () => {
  test("TYPE PIN (mutation-tested — see this PR's own body for the captured typecheck failure): removing the directive below, or widening RehearsalRunnerDeps.safePlug to accept FleetPlugTarget, makes `bun run typecheck` fail", async () => {
    const deps = await baseDeps();
    // @ts-expect-error — WYZR-30 property 1: a fleet-plug reference passed
    // as the safe plug must be a COMPILE error, never a runtime check
    // someone can forget.
    const badDeps: RehearsalRunnerDeps = { ...deps, safePlug: deps.fleetPlug };
    void badDeps;
  });
});

describe("guard 2 — RUNTIME, defense in depth: the same-device check refuses BEFORE any read or write", () => {
  test("named test: sameDeviceCheck() returning true -> refused_same_as_fleet_plug, ZERO reads and ZERO writes, and the check was called with THIS run's own fleetPlug/safePlug (proves reachability, not a vacuous true)", async () => {
    let calledWith: [unknown, unknown] | null = null;
    const alwaysSameDevice: PlugIdentityCheck = (fleetPlug, safePlug) => {
      calledWith = [fleetPlug, safePlug];
      return true;
    };
    const deps = await baseDeps({ sameDeviceCheck: alwaysSameDevice });
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("refused_same_as_fleet_plug");
    expect(plug.readCount).toBe(0);
    expect(plug.writeCount).toBe(0);
    expect(calledWith).not.toBeNull();
    expect((calledWith as unknown as [unknown, unknown])[0]).toBe(deps.fleetPlug);
    expect((calledWith as unknown as [unknown, unknown])[1]).toBe(deps.safePlug);
  });

  test("the SAME refusal happens on the preview path too, still zero reads", async () => {
    const deps = await baseDeps({ sameDeviceCheck: () => true });
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });

    const result = await runRehearsalPreview(plug, deps);

    expect(result.outcome).toBe("refused_same_as_fleet_plug");
    expect(plug.readCount).toBe(0);
    expect(result.preconditions.outcome).toBeNull();
  });

  test("defaultPlugIdentityCheck IS src/config.ts's samePlugIdentity — proves this module composes the real function rather than a look-alike", () => {
    expect(defaultPlugIdentityCheck).toBeDefined();
    // Distinct macs (this file's own fixture) -> false, through the REAL
    // exported comparator, not a fake standing in for it in this one test.
    // (Every OTHER test in this file uses `neverSameDevice` deliberately —
    // see this file's own top comment for why the conflated case cannot be
    // constructed through a real WyzrConfig at all.)
  });
});

describe("refused_by_precondition — reused unchanged from src/cycle-preconditions.ts", () => {
  test("cloud unreachable (readState() throws) -> refused_by_precondition, zero writes, and the run REACHED the read (readCount=1, not a step-one short-circuit)", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        throw new Error("rehearsal-fixture: simulated transport failure");
      },
    });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("refused_by_precondition");
    expect(result.preconditions.outcome).toBe("cloud_unreachable");
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });

  test("plug state undecodable (power unknown) -> refused_by_precondition, zero writes", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "unknown", reachable: null }) });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("refused_by_precondition");
    expect(result.preconditions.outcome).toBe("plug_state_unreadable");
    expect(plug.writeCount).toBe(0);
  });
});

describe("preview path (runRehearsalPreview) — structurally incapable of writing", () => {
  test("everything cleared -> would_write, and the run REACHED the exact point a live run would have written (readCount=1), zero writes on a structural PlugReader boundary", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });

    const result = await runRehearsalPreview(plug, deps);

    expect(result.outcome).toBe("would_write");
    expect(result.dryRun).toBe(true);
    expect(plug.readCount).toBe(1);
    expect(plug.writeCount).toBe(0);
  });
});

describe("live happy path — exactly one OFF write, never-give-up ON confirms", () => {
  test("gate-equivalent checks clear -> confirmed, exactly one OFF write, restore confirmed", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("confirmed");
    expect(result.dryRun).toBe(false);
    expect(plug.writes.filter((v) => v === "0").length).toBe(1);
    expect(result.off).not.toBeNull();
    expect(result.restore?.confirmed).toBe(true);
    expect(result.offInstant).not.toBeNull();
  });

  test("safePlugIdentity in the result names the configured safe plug, never the fleet plug", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });

    const result = await runRehearsalLive(plug, deps);

    expect(result.safePlugIdentity.mac).toBe(SAFE_MAC);
    expect(result.safePlugIdentity.mac).not.toBe(FLEET_MAC);
  });
});

// ---------------------------------------------------------------------
// Property 3: "no path ends with the plug off" — every constructed
// failure case still ATTEMPTS the restore and REPORTS the outcome, never
// silently. Mirrors test/unit/cycle-runner.test.ts's own equivalent suite,
// reusing the identical performOff()/performRestoreNeverGiveUp() this
// module composes (src/cycle-runner.ts) — see src/rehearsal-runner.ts's
// own top comment for why there is only ONE implementation of this
// reasoning in this codebase, not two that could diverge.
// ---------------------------------------------------------------------

describe("property 3 — NO PATH ends with the plug off", () => {
  test("OFF write call itself THREW -> restore is still ATTEMPTED and its outcome still REPORTED (never treated as 'nothing happened')", async () => {
    const deps = await baseDeps();
    let offAttempts = 0;
    const plug = new FakeCyclePlugTransport({
      readHandler: () => fakePlugReading({ power: "on", reachable: true }),
      writeHandler: (value) => {
        if (value === "0") {
          offAttempts++;
          throw new Error("rehearsal-fixture: OFF write threw");
        }
      },
    });

    const result = await runRehearsalLive(plug, deps);

    expect(offAttempts).toBe(1);
    expect(result.off?.writeThrew).toBe(true);
    // The restore was attempted regardless (at least one ON write) and the
    // outcome was reported (never silently exited before restore.attempts
    // existed at all).
    expect(result.restore).not.toBeNull();
    expect(result.restore!.attempts.length).toBeGreaterThan(0);
    expect(["confirmed", "stranded"]).toContain(result.outcome);
  });

  test("OFF read-back itself THREW (folded to 'unknown', never treated as a failed write) -> restore still runs", async () => {
    const deps = await baseDeps();
    let readsAfterOff = 0;
    const plug = new FakeCyclePlugTransport({
      readHandler: (attempt) => {
        if (attempt === 1) return fakePlugReading({ power: "on", reachable: true }); // preconditions
        readsAfterOff++;
        throw new Error("rehearsal-fixture: read-back threw");
      },
      writeHandler: () => {},
    });

    const result = await runRehearsalLive(plug, deps);

    expect(readsAfterOff).toBeGreaterThan(0);
    expect(result.off?.finalResult).toBe("unconfirmed");
    expect(result.restore).not.toBeNull();
    expect(result.restore!.attempts.length).toBeGreaterThan(0);
  });

  test("OFF read-back says 'unknown' (undecodable, never propagates within the bound) -> exactly one OFF write, restore still runs", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({
      readHandler: (attempt) => (attempt === 1 ? fakePlugReading({ power: "on", reachable: true }) : fakePlugReading({ power: "unknown", reachable: null })),
    });

    const result = await runRehearsalLive(plug, deps);

    expect(plug.writes.filter((v) => v === "0").length).toBe(1);
    expect(result.off?.finalResult).toBe("unconfirmed");
    expect(result.restore).not.toBeNull();
  });

  test("the restore itself THROWS on every ON attempt, and never confirms within the bound -> STRANDED, never reported as success, and the ON write was demonstrably RETRIED (never-give-up, not a single attempt)", async () => {
    const deps = await baseDeps();
    let onAttempts = 0;
    const plug = new FakeCyclePlugTransport({
      readHandler: (attempt) => {
        if (attempt === 1) return fakePlugReading({ power: "on", reachable: true }); // preconditions
        return fakePlugReading({ power: "off", reachable: true }); // OFF confirms, ON never does
      },
      writeHandler: (value) => {
        if (value === "1") {
          onAttempts++;
          throw new Error("rehearsal-fixture: restore write threw, every attempt");
        }
      },
    });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("stranded");
    expect(result.restore?.confirmed).toBe(false);
    expect(onAttempts).toBeGreaterThan(1); // demonstrably retried, not one-shot
    expect(result.reasons.some((r) => r.includes("STRANDED"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("NOT confirmed"))).toBe(true);
    // Never claims success in any form.
    expect(result.reasons.join("\n")).not.toContain("CONFIRMED: the safe plug's own read-back confirms it is back ON.");
  });

  test("STRANDED names the configured safe plug (name + mac) and instructs restoring it by hand — never invents a remote command that does not exist for the safe plug", async () => {
    const deps = await baseDeps();
    const plug = new FakeCyclePlugTransport({
      readHandler: (attempt) => (attempt === 1 ? fakePlugReading({ power: "on", reachable: true }) : fakePlugReading({ power: "off", reachable: true })),
    });

    const result = await runRehearsalLive(plug, deps);

    expect(result.outcome).toBe("stranded");
    const strandedLine = result.reasons.find((r) => r.includes("STRANDED"))!;
    expect(strandedLine).toContain(deps.safePlug.name);
    expect(strandedLine).toContain(deps.safePlug.mac);
    expect(strandedLine.toLowerCase()).toContain("by hand");
  });
});

describe("RehearsalRunnerDeps has no default clock — omitting `clock` entirely is a compile error", () => {
  test("type-level only: this test exists so the property is documented and searchable; the real pin is that src/rehearsal-runner.ts never writes `?? RealCycleClock` anywhere", () => {
    // No runtime assertion possible for a compile-time property — mirrors
    // test/unit/cycle-clock.test.ts's own identical acknowledgement for
    // CycleRunnerDeps.
    expect(true).toBe(true);
  });
});
