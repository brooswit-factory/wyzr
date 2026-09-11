// src/cli-doctor.ts: the --json contract, human rendering, exit-code
// mapping, and dispatch wiring for `wyzr doctor`. Orchestration itself
// (which check produces which outcome under which input) is
// test/unit/doctor-runner.test.ts's job; this file exercises the output
// boundary and the exit-code precedent, plus src/cli.ts's own dispatch.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWyzrConfig, type WyzrConfig, type WyzrConfigEnv } from "../../src/config.ts";
import type { Credentials } from "../../src/credentials.ts";
import { ExitCode } from "../../src/errors.ts";
import { resetSecretsForTesting } from "../../src/redact.ts";
import { doctorVerdictExitCode, formatDoctorHuman, runDoctorCommand, toDoctorJson } from "../../src/cli-doctor.ts";
import { defaultDoctorRunnerDeps, type DoctorRunnerDeps } from "../../src/doctor-runner.ts";
import { DoctorVerdict, type DoctorResult } from "../../src/doctor.ts";
import { dispatchDoctor } from "../../src/cli.ts";
import { FAKE_PLUG_ONLINE, FakeWyzeTransport, fakeGetObjectListEnvelope, fakePropertyListEnvelope } from "../../src/transport-fake.ts";
import { FakeWedgeProbes } from "../../src/wedge-probes-fake.ts";
import { RealWrongBoxIdentityProbe, type WrongBoxIdentityProbe } from "../../src/cycle-wrong-box.ts";
import { RealWedgeProbes } from "../../src/wedge-probes-real.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  resetSecretsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FLEET_MAC = "AA:BB:CC:DD:EE:01";
const SAFE_MAC = "11:22:33:44:55:02";

async function buildWyzrConfig(overrides: Record<string, unknown> = {}): Promise<WyzrConfig> {
  const base = await mkdtemp(join(tmpdir(), "wyzr-cli-doctor-test-"));
  tempDirs.push(base);
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const path = join(dir, "config.json");
  const content = {
    suspectBox: { host: "cli-doctor-fixture-suspect-box.invalid" },
    fleetPlug: { mac: FLEET_MAC, model: "WLPP1CFH", name: "fixture-fleet-plug" },
    safePlug: { mac: SAFE_MAC, model: "WLPPO", name: "fixture-safe-plug", subDeviceId: `${SAFE_MAC}-SUB1` },
    ...overrides,
  };
  await writeFile(path, JSON.stringify(content), "utf8");
  await chmod(path, 0o600);
  const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };
  return loadWyzrConfig(env);
}

const FAKE_CREDS: Credentials = {
  email: "cli-doctor-fixture@example.invalid",
  password: "fixture-password-000",
  keyId: "fixture-key-id-000",
  keySecret: "fixture-key-secret-000",
  totpSecret: undefined,
};

class NotTargetProbe implements WrongBoxIdentityProbe {
  async resolveTargetAddresses(): Promise<readonly string[] | null> {
    return ["203.0.113.5"];
  }
  async getLocalAddresses(): Promise<readonly string[]> {
    return ["203.0.113.9"];
  }
}

/** A config with BOTH optional instrument sections filled in — a doctor
 * run against this, with everything else healthy, is the one scenario that
 * reaches READY rather than UNCONFIGURED: with either section left out,
 * that instrument reports "not-configured," and this repo's own precedent
 * (mirroring src/recovery.ts's `evaluateRecovery()`) is that ANY
 * not-configured check — even a purely optional one — keeps the overall
 * verdict at UNCONFIGURED rather than READY. See test/unit/doctor.test.ts's
 * "an otherwise-healthy install with one never-configured optional
 * instrument still reads UNCONFIGURED" test for that rule in isolation. */
async function readyDeps(): Promise<DoctorRunnerDeps> {
  const config = await buildWyzrConfig({
    jira: { baseUrl: "https://fixture.atlassian.invalid", authHeader: "Basic fixture-not-real", quietThresholdMs: 60000, timeoutMs: 5000 },
    github: { owner: "fixture-org", quietThresholdMs: 60000, timeoutMs: 5000 },
  });
  return {
    loadConfig: () => config,
    loadCredentials: async () => FAKE_CREDS,
    createTransport: () =>
      new FakeWyzeTransport({
        getObjectListHandler: () =>
          fakeGetObjectListEnvelope([
            { ...FAKE_PLUG_ONLINE, mac: FLEET_MAC, model: "WLPP1CFH", nickname: "fixture-fleet-plug" },
            { ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, model: "WLPPO", nickname: "fixture-safe-plug" },
          ]),
        getPropertyListHandler: () => fakePropertyListEnvelope({ P3: "1", P5: "1" }),
      }),
    createWedgeProbes: () =>
      new FakeWedgeProbes({
        jiraHandler: async () => ({ outcome: "observed", lastSeenAt: Date.now(), note: null }),
        gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: Date.now(), note: null }),
      }),
    createIdentityProbe: () => new NotTargetProbe(),
  };
}

function silence(): { restore: () => void; log: ReturnType<typeof spyOn> } {
  const log = spyOn(console, "log").mockImplementation(() => {});
  return { restore: () => log.mockRestore(), log };
}

describe("doctorVerdictExitCode — a distinct exit code per verdict class", () => {
  test("READY maps to Ok (0)", () => {
    expect(doctorVerdictExitCode(DoctorVerdict.Ready)).toBe(ExitCode.Ok);
  });

  test("each non-READY verdict maps to its own dedicated, distinct code", () => {
    const codes = [
      doctorVerdictExitCode(DoctorVerdict.NotReady),
      doctorVerdictExitCode(DoctorVerdict.Inconclusive),
      doctorVerdictExitCode(DoctorVerdict.Unconfigured),
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([ExitCode.DoctorNotReady, ExitCode.DoctorInconclusive, ExitCode.DoctorUnconfigured]);
  });
});

describe("runDoctorCommand — never throws for a diagnostic outcome (OUTCOME codes, not error codes)", () => {
  test("READY returns exit 0", async () => {
    const s = silence();
    try {
      const code = await runDoctorCommand(await readyDeps(), false);
      expect(code).toBe(ExitCode.Ok);
    } finally {
      s.restore();
    }
  });

  test("a login failure returns exit DoctorNotReady, no throw", async () => {
    const s = silence();
    try {
      const config = await buildWyzrConfig();
      const deps: DoctorRunnerDeps = {
        loadConfig: () => config,
        loadCredentials: async () => FAKE_CREDS,
        createTransport: () => new FakeWyzeTransport({ loginHandler: async () => { throw new Error("fixture: login refused"); } }),
        createWedgeProbes: () => new FakeWedgeProbes(),
        createIdentityProbe: () => new NotTargetProbe(),
      };
      const code = await runDoctorCommand(deps, true);
      expect(code).toBe(ExitCode.DoctorNotReady);
    } finally {
      s.restore();
    }
  });
});

describe("toDoctorJson — the --json contract", () => {
  test("carries schemaVersion, command, verdict, every check, and the wrong-box guard's raw outcome/reasons", async () => {
    const s = silence();
    let result: DoctorResult;
    try {
      const { runDoctorCheck } = await import("../../src/doctor-runner.ts");
      result = await runDoctorCheck(await readyDeps());
    } finally {
      s.restore();
    }
    const json = toDoctorJson(result);
    expect(json.schemaVersion).toBe(1);
    expect(json.command).toBe("doctor");
    expect(json.verdict).toBe(DoctorVerdict.Ready);
    expect(json.fleetPlug.mac).toBe(FLEET_MAC);
    expect(json.safePlug.mac).toBe(SAFE_MAC);
    expect(json.wrongBoxGuard.outcome).toBe("not_target");
    expect(Array.isArray(json.wrongBoxGuard.reasons)).toBe(true);
    expect(Array.isArray(json.unproven)).toBe(true);
    expect(json.unproven.length).toBeGreaterThan(0);
    // Never a raw spread carrying an internal-only field.
    expect(Object.keys(json)).not.toContain("__brand");
  });
});

describe("formatDoctorHuman", () => {
  test("names the verdict, every check's PASS/FAIL/COULD-NOT-LOOK/NOT-CONFIGURED state, and the unproven section", async () => {
    const s = silence();
    let result: DoctorResult;
    try {
      const { runDoctorCheck } = await import("../../src/doctor-runner.ts");
      result = await runDoctorCheck(await readyDeps());
    } finally {
      s.restore();
    }
    const human = formatDoctorHuman(result);
    expect(human).toContain("Verdict: READY");
    expect(human).toContain("PASS");
    expect(human).toContain("What remains unproven:");
    expect(human).toContain("wrong-box guard: NOT_TARGET");
  });

  test("renders FAIL, COULD-NOT-LOOK, and NOT-CONFIGURED tags distinctly, never collapsing them to the same word", async () => {
    const s = silence();
    let result: DoctorResult;
    try {
      const { runDoctorCheck } = await import("../../src/doctor-runner.ts");
      const config = await buildWyzrConfig();
      const deps: DoctorRunnerDeps = {
        loadConfig: () => config,
        loadCredentials: async () => FAKE_CREDS,
        createTransport: () => new FakeWyzeTransport({ loginHandler: async () => { throw new Error("fixture: login refused"); } }),
        createWedgeProbes: () => new FakeWedgeProbes(),
        createIdentityProbe: () => new NotTargetProbe(),
      };
      result = await runDoctorCheck(deps);
    } finally {
      s.restore();
    }
    const human = formatDoctorHuman(result);
    expect(human).toContain("cloud (login attempt): FAIL");
    expect(human).toContain("resolvable (present in this account's own device list): COULD-NOT-LOOK");
    expect(human).toContain("instrument \"jira-activity\": NOT-CONFIGURED");
  });
});

describe("dispatchDoctor — src/cli.ts's own routing", () => {
  test("rejects unexpected extra arguments as a usage error", async () => {
    await expect(dispatchDoctor(["extra-arg"], false)).rejects.toThrow(/Usage: wyzr doctor/);
  });

  test("routes to runDoctorCommand with no arguments", async () => {
    const s = silence();
    try {
      const code = await dispatchDoctor([], false, await readyDeps());
      expect(code).toBe(ExitCode.Ok);
    } finally {
      s.restore();
    }
  });
});

describe("defaultDoctorRunnerDeps — the real (production) wiring, exercised only for construction, never invoked", () => {
  test("createTransport() constructs a RealWyzeTransport-shaped object with no network call yet", () => {
    expect(() => defaultDoctorRunnerDeps.createTransport()).not.toThrow();
  });

  test("createWedgeProbes() constructs a RealWedgeProbes", () => {
    expect(defaultDoctorRunnerDeps.createWedgeProbes()).toBeInstanceOf(RealWedgeProbes);
  });

  test("createIdentityProbe() constructs a RealWrongBoxIdentityProbe", () => {
    expect(defaultDoctorRunnerDeps.createIdentityProbe()).toBeInstanceOf(RealWrongBoxIdentityProbe);
  });

  test("loadConfig() either returns a real WyzrConfig or refuses with ConfigInvalid/CredentialsInvalid — never anything else", () => {
    try {
      const config = defaultDoctorRunnerDeps.loadConfig();
      expect(config.fleetPlug).toBeDefined();
    } catch (err) {
      const exitCode = (err as { exitCode?: number }).exitCode;
      expect(exitCode === ExitCode.ConfigInvalid || exitCode === ExitCode.CredentialsInvalid).toBe(true);
    }
  });

  test("loadCredentials() either returns real Credentials or refuses with CredentialsInvalid — never anything else", async () => {
    try {
      const credentials = await defaultDoctorRunnerDeps.loadCredentials();
      expect(typeof credentials.email).toBe("string");
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(ExitCode.CredentialsInvalid);
    }
  });
});
