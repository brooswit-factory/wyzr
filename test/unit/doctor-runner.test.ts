// End-to-end orchestration tests for `wyzr doctor`'s I/O layer
// (src/doctor-runner.ts) against FakeWyzeTransport/FakeWedgeProbes/a
// hand-built WrongBoxIdentityProbe fake and a REAL `loadWyzrConfig()` call
// against a temp-directory fixture — zero credentials file on the real
// filesystem, zero network. `WyzrConfig.fleetPlug`/`.safePlug` are branded
// with a module-private `unique symbol` (src/config.ts) that nothing
// outside that module can spell, so the only legitimate way to mint one for
// a test fixture is through the real loader itself — same technique
// test/unit/config.test.ts's own fixtures use, reused here rather than an
// `as unknown as FleetPlugTarget` cast, which src/config.ts's own top
// comment calls out as "a lie a reviewer would have to wave through."

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWyzrConfig, type WyzrConfig, type WyzrConfigEnv } from "../../src/config.ts";
import type { Credentials } from "../../src/credentials.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { resetSecretsForTesting } from "../../src/redact.ts";
import { runDoctorCheck, type DoctorRunnerDeps } from "../../src/doctor-runner.ts";
import { DoctorVerdict } from "../../src/doctor.ts";
import {
  FAKE_PLUG_ONLINE,
  FakeWyzeTransport,
  fakeAuthInvalidCredentialsEnvelope,
  fakeGetObjectListEnvelope,
  fakePropertyListEnvelope,
} from "../../src/transport-fake.ts";
import { FakeWedgeProbes, fakeJiraActivityReading, fakeGitHubActivityReading } from "../../src/wedge-probes-fake.ts";
import type { WrongBoxIdentityProbe } from "../../src/cycle-wrong-box.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  resetSecretsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FLEET_MAC = "AA:BB:CC:DD:EE:01";
const SAFE_MAC = "11:22:33:44:55:02";

/** Mints a real, properly-branded WyzrConfig by writing a fixture file and
 * calling the actual loader — see this file's own top comment for why. */
async function buildWyzrConfig(overrides: Record<string, unknown> = {}): Promise<WyzrConfig> {
  const base = await mkdtemp(join(tmpdir(), "wyzr-doctor-test-"));
  tempDirs.push(base);
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const path = join(dir, "config.json");
  const content = {
    suspectBox: { host: "doctor-fixture-suspect-box.invalid" },
    fleetPlug: { mac: FLEET_MAC, model: "WLPP1CFH", name: "fixture-fleet-plug" },
    safePlug: { mac: SAFE_MAC, model: "WLPPO", name: "fixture-safe-plug", subDeviceId: `${SAFE_MAC}-SUB1` },
    ...overrides,
  };
  await writeFile(path, JSON.stringify(content), "utf8");
  await chmod(path, 0o600);
  const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };
  return loadWyzrConfig(env);
}

/** Builds a config fixture at `base` but never loads it — for the "config
 * present but broken" tests, which need `loadWyzrConfig()` itself to
 * throw. */
async function brokenConfigLoader(content: unknown, opts: { fileMode?: number } = {}): Promise<() => WyzrConfig> {
  const base = await mkdtemp(join(tmpdir(), "wyzr-doctor-test-broken-"));
  tempDirs.push(base);
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const path = join(dir, "config.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  await chmod(path, opts.fileMode ?? 0o600);
  const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };
  return () => loadWyzrConfig(env);
}

const FAKE_CREDS: Credentials = {
  email: "doctor-fixture@example.invalid",
  password: "fixture-password-000",
  keyId: "fixture-key-id-000",
  keySecret: "fixture-key-secret-000",
  totpSecret: undefined,
};

const TARGET_ADDRESS = "203.0.113.5";
const LOCAL_ADDRESS_NOT_TARGET = "203.0.113.9";

class FakeIdentityProbe implements WrongBoxIdentityProbe {
  constructor(
    private readonly targetAddresses: readonly string[] | null,
    private readonly localAddresses: readonly string[],
  ) {}
  async resolveTargetAddresses(): Promise<readonly string[] | null> {
    return this.targetAddresses;
  }
  async getLocalAddresses(): Promise<readonly string[]> {
    return this.localAddresses;
  }
}

function notTargetProbe(): WrongBoxIdentityProbe {
  return new FakeIdentityProbe([TARGET_ADDRESS], [LOCAL_ADDRESS_NOT_TARGET]);
}

function isTargetProbe(): WrongBoxIdentityProbe {
  return new FakeIdentityProbe([TARGET_ADDRESS], [TARGET_ADDRESS]);
}

function happyTransport(): FakeWyzeTransport {
  return new FakeWyzeTransport({
    getObjectListHandler: () =>
      fakeGetObjectListEnvelope([
        { ...FAKE_PLUG_ONLINE, mac: FLEET_MAC, model: "WLPP1CFH", nickname: "fixture-fleet-plug" },
        { ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, model: "WLPPO", nickname: "fixture-safe-plug" },
      ]),
    getPropertyListHandler: () => fakePropertyListEnvelope({ P3: "1", P5: "1" }),
  });
}

async function baseDeps(overrides: Partial<DoctorRunnerDeps> = {}): Promise<DoctorRunnerDeps> {
  const config = await buildWyzrConfig();
  return {
    loadConfig: () => config,
    loadCredentials: async () => FAKE_CREDS,
    createTransport: () => happyTransport(),
    createWedgeProbes: () => new FakeWedgeProbes(),
    createIdentityProbe: () => notTargetProbe(),
    ...overrides,
  };
}

describe("runDoctorCheck — the full happy path", () => {
  test("everything configured and healthy -> READY", async () => {
    const config = await buildWyzrConfig({
      jira: { baseUrl: "https://fixture.atlassian.invalid", authHeader: "Basic fixture-not-real", quietThresholdMs: 60000, timeoutMs: 5000 },
      github: { owner: "fixture-org", quietThresholdMs: 60000, timeoutMs: 5000 },
    });
    const deps = await baseDeps({
      loadConfig: () => config,
      createWedgeProbes: () =>
        new FakeWedgeProbes({
          jiraHandler: async () => fakeJiraActivityReading(Date.now()),
          gitHubHandler: async () => fakeGitHubActivityReading(Date.now()),
        }),
    });

    const result = await runDoctorCheck(deps);
    expect(result.verdict).toBe(DoctorVerdict.Ready);
    expect(result.config.outcome).toBe("pass");
    expect(result.credentials.outcome).toBe("pass");
    expect(result.cloud.outcome).toBe("pass");
    expect(result.fleetPlug.resolvable).toBe("pass");
    expect(result.fleetPlug.readable).toBe("pass");
    expect(result.safePlug.resolvable).toBe("pass");
    expect(result.safePlug.readable).toBe("pass");
    expect(result.wrongBoxGuard.outcome).toBe("not_target");
    expect(result.unproven.length).toBeGreaterThan(0);
  });
});

describe("runDoctorCheck — a totally fresh install (no config, no credentials) reads as UNCONFIGURED, never NOT_READY", () => {
  test("named test: 'not configured' is a distinct, calmer state than a broken install", async () => {
    const base = await mkdtemp(join(tmpdir(), "wyzr-doctor-test-empty-"));
    tempDirs.push(base);
    const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };

    const deps: DoctorRunnerDeps = {
      loadConfig: () => loadWyzrConfig(env),
      loadCredentials: () => {
        throw new CliError("No credentials file found.", ExitCode.CredentialsInvalid, "credentials_missing");
      },
      createTransport: () => happyTransport(),
      createWedgeProbes: () => new FakeWedgeProbes(),
      createIdentityProbe: () => notTargetProbe(),
    };

    const result = await runDoctorCheck(deps);
    expect(result.config.outcome).toBe("not-configured");
    expect(result.credentials.outcome).toBe("not-configured");
    expect(result.cloud.outcome).toBe("not-configured");
    expect(result.fleetPlug.resolvable).toBe("not-configured");
    expect(result.fleetPlug.readable).toBe("not-configured");
    expect(result.wrongBoxGuard.outcome).toBe("inconclusive");
    expect(result.checks.wrongBoxGuard).toBe("not-configured");
    expect(result.verdict).toBe(DoctorVerdict.Unconfigured);
    expect(result.verdict).not.toBe(DoctorVerdict.NotReady);
  });
});

describe("runDoctorCheck — credentials present but broken -> FAIL, distinct from not-configured", () => {
  test("a credentials load failure that is NOT 'credentials_missing' reads as fail, and blocks cloud with could-not-look", async () => {
    const deps = await baseDeps({
      loadCredentials: async () => {
        throw new CliError(
          "Credentials file is readable by group or others (mode 644).",
          ExitCode.CredentialsInvalid,
          "credentials_file_mode",
        );
      },
    });
    const result = await runDoctorCheck(deps);
    expect(result.credentials.outcome).toBe("fail");
    expect(result.credentials.note).toContain("readable by group or others");
    expect(result.cloud.outcome).toBe("could-not-look");
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });

  test("a non-CliError throw from loadCredentials also reads as fail, not not-configured", async () => {
    const deps = await baseDeps({
      loadCredentials: async () => {
        throw new Error("fixture: unexpected filesystem error");
      },
    });
    const result = await runDoctorCheck(deps);
    expect(result.credentials.outcome).toBe("fail");
    expect(result.credentials.note).toBe("fixture: unexpected filesystem error");
  });
});

describe("runDoctorCheck — config present but broken -> FAIL, distinct from not-configured", () => {
  test("named test: config with bad file permissions reads as fail, not not-configured, and downstream checks read could-not-look, not not-configured", async () => {
    const loadConfig = await brokenConfigLoader(
      { suspectBox: { host: "x" }, fleetPlug: { mac: FLEET_MAC, model: "WLPP1CFH", name: "f" }, safePlug: { mac: SAFE_MAC, model: "WLPPO", name: "s" } },
      { fileMode: 0o644 },
    );
    const deps: DoctorRunnerDeps = {
      loadConfig,
      loadCredentials: async () => FAKE_CREDS,
      createTransport: () => happyTransport(),
      createWedgeProbes: () => new FakeWedgeProbes(),
      createIdentityProbe: () => notTargetProbe(),
    };

    const result = await runDoctorCheck(deps);
    expect(result.config.outcome).toBe("fail");
    expect(result.config.note).toContain("readable by group or others");
    expect(result.fleetPlug.resolvable).toBe("could-not-look");
    expect(result.fleetPlug.readable).toBe("could-not-look");
    expect(result.checks.wrongBoxGuard).toBe("could-not-look");
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });
});

describe("runDoctorCheck — rule 2 of the ticket: never diagnoses WHY authentication failed", () => {
  test("named test: an errorCode-1000-shaped failure is relayed VERBATIM, with no re-interpretation appended", async () => {
    const deps = await baseDeps({
      createTransport: () => new FakeWyzeTransport({ loginHandler: () => fakeAuthInvalidCredentialsEnvelope() }),
    });
    const result = await runDoctorCheck(deps);
    expect(result.cloud.outcome).toBe("fail");
    // The exact message wyze-errors.ts's wyzeInvalidCredentialsOrSsoOnlyError()
    // produces — asserted in full so a future change that appends doctor-authored
    // commentary on top of it (re-diagnosing rather than relaying) fails this test.
    expect(result.cloud.note).toContain("errorCode 1000");
    expect(result.cloud.note).not.toContain("wrong password"); // never asserts WHICH of the 3 causes
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });

  test("a raw transport-level throw (never even reached a Wyze response) is ALSO just relayed verbatim, same shape as an API-level failure", async () => {
    const deps = await baseDeps({
      createTransport: () =>
        new FakeWyzeTransport({
          loginHandler: async () => {
            throw new Error("getaddrinfo ENOTFOUND fixture-auth-host.invalid");
          },
        }),
    });
    const result = await runDoctorCheck(deps);
    expect(result.cloud.outcome).toBe("fail");
    expect(result.cloud.note).toBe("getaddrinfo ENOTFOUND fixture-auth-host.invalid");
  });
});

describe("runDoctorCheck — the target plugs: resolvable and readable are independent facts", () => {
  test("a plug whose mac is not on the account's own device list -> resolvable fail, even though readable can still independently succeed", async () => {
    const deps = await baseDeps({
      createTransport: () =>
        new FakeWyzeTransport({
          // Device list omits the fleet plug's mac entirely.
          getObjectListHandler: () => fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, model: "WLPPO", nickname: "fixture-safe-plug" }]),
          getPropertyListHandler: () => fakePropertyListEnvelope({ P3: "1", P5: "1" }),
        }),
    });
    const result = await runDoctorCheck(deps);
    expect(result.fleetPlug.resolvable).toBe("fail");
    expect(result.fleetPlug.readable).toBe("pass"); // independently attempted and succeeded
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });

  test("an undecodable P3/P5 reading -> could-not-look, never fail — and, alone, the overall verdict is INCONCLUSIVE not NOT_READY", async () => {
    const deps = await baseDeps({
      createTransport: () =>
        new FakeWyzeTransport({
          getObjectListHandler: () =>
            fakeGetObjectListEnvelope([
              { ...FAKE_PLUG_ONLINE, mac: FLEET_MAC, model: "WLPP1CFH", nickname: "fixture-fleet-plug" },
              { ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, model: "WLPPO", nickname: "fixture-safe-plug" },
            ]),
          getPropertyListHandler: () => fakePropertyListEnvelope({}), // neither P3 nor P5 present
        }),
    });
    const result = await runDoctorCheck(deps);
    expect(result.fleetPlug.readable).toBe("could-not-look");
    expect(result.fleetPlug.readable).not.toBe("fail");
    expect(result.verdict).toBe(DoctorVerdict.Inconclusive);
  });

  test("the device-list fetch itself failing blocks BOTH plugs' resolvable check with could-not-look, independent of readable", async () => {
    const deps = await baseDeps({
      createTransport: () =>
        new FakeWyzeTransport({
          getObjectListHandler: async () => {
            throw new Error("Wyze API returned an error (code 2001).");
          },
          getPropertyListHandler: () => fakePropertyListEnvelope({ P3: "1", P5: "1" }),
        }),
    });
    const result = await runDoctorCheck(deps);
    expect(result.fleetPlug.resolvable).toBe("could-not-look");
    expect(result.safePlug.resolvable).toBe("could-not-look");
    expect(result.fleetPlug.readable).toBe("pass");
  });
});

describe("runDoctorCheck — the wrong-box guard's own verdict is reported verbatim, and IS_TARGET is never buried", () => {
  test("named test: this machine resolving as the configured target forces NOT_READY", async () => {
    const deps = await baseDeps({ createIdentityProbe: () => isTargetProbe() });
    const result = await runDoctorCheck(deps);
    expect(result.wrongBoxGuard.outcome).toBe("is_target");
    expect(result.wrongBoxGuard.reasons.length).toBeGreaterThan(0);
    expect(result.verdict).toBe(DoctorVerdict.NotReady);
  });
});

describe("runDoctorCheck — instruments: configured-or-not, reachable-or-not, independently", () => {
  test("a timing-out instrument reads could-not-look, not fail, and (alone) the overall verdict is INCONCLUSIVE", async () => {
    const config = await buildWyzrConfig({
      jira: { baseUrl: "https://fixture.atlassian.invalid", authHeader: "Basic fixture-not-real", quietThresholdMs: 60000, timeoutMs: 5000 },
    });
    const deps = await baseDeps({
      loadConfig: () => config,
      createWedgeProbes: () => new FakeWedgeProbes({ jiraHandler: async () => ({ outcome: "timeout", lastSeenAt: null, note: "fixture: no reply within timeout" }) }),
    });
    const result = await runDoctorCheck(deps);
    const jira = result.instruments.find((i) => i.name === "jira-activity")!;
    expect(jira.outcome).toBe("could-not-look");
    expect(jira.note).toBe("fixture: no reply within timeout");
    expect(result.verdict).toBe(DoctorVerdict.Inconclusive);
  });

  test("no jira/github section at all -> both report not-configured by their canonical names, never silently absent", async () => {
    const deps = await baseDeps();
    const result = await runDoctorCheck(deps);
    expect(result.instruments.map((i) => i.name).sort()).toEqual(["github-activity", "jira-activity"]);
    expect(result.instruments.every((i) => i.outcome === "not-configured")).toBe(true);
  });
});

describe("runDoctorCheck — named test: config and credentials report presence/position/permission, never a configured value", () => {
  test("a distinctive jira authHeader value never appears anywhere in the doctor's own result", async () => {
    const distinctiveMarker = "Basic fixture-marker-should-never-leak-abc123xyz";
    const config = await buildWyzrConfig({
      jira: { baseUrl: "https://fixture.atlassian.invalid", authHeader: distinctiveMarker, quietThresholdMs: 60000, timeoutMs: 5000 },
    });
    const deps = await baseDeps({ loadConfig: () => config });
    const result = await runDoctorCheck(deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(distinctiveMarker);
    expect(serialized).not.toContain("fixture-marker-should-never-leak");
  });

  test("a distinctive credentials password value never appears anywhere in the doctor's own result", async () => {
    const distinctivePassword = "fixture-password-should-never-leak-000";
    const deps = await baseDeps({ loadCredentials: async () => ({ ...FAKE_CREDS, password: distinctivePassword }) });
    const result = await runDoctorCheck(deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(distinctivePassword);
  });
});
