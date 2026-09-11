import { describe, expect, test } from "bun:test";
import { ExitCode } from "../../src/errors.ts";
import {
  defaultRecoveryStatusDeps,
  formatRecoveryStatusHuman,
  recoveryVerdictExitCode,
  runRecoveryStatus,
  toRecoveryStatusJson,
  type RecoveryStatusDeps,
} from "../../src/cli-recovery.ts";
import { RealWedgeProbes } from "../../src/wedge-probes-real.ts";
import { RealRecoveryProbes } from "../../src/recovery-probes-real.ts";
import { evaluateRecovery, RecoveryVerdict } from "../../src/recovery.ts";
import { FakeWedgeProbes, fakeDirectPathAlive, fakeDirectPathDead, fakeLocalControlHealthy, fakeLocalControlUnhealthy } from "../../src/wedge-probes-fake.ts";
import { FakeRecoveryProbes, fakeDaemonHealthy, fakeDaemonUnhealthy, fakeFleetEnumerated, fakeUptimeObserved } from "../../src/recovery-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY } from "../../src/wedge-config.ts";
import type { RecoveryConfig } from "../../src/recovery-config.ts";

const SINCE = 1_800_000_000_000;
const NOW = SINCE + 100_000;

function fullConfig(): RecoveryConfig {
  return {
    jira: {
      name: "jira-activity",
      baseUrl: "https://example-not-real.atlassian.net",
      authHeader: "Basic fake",
      dependsOn: [MANAGER_INTERNET_DEPENDENCY],
      quietThresholdMs: 60_000,
      timeoutMs: 1000,
    },
    github: {
      name: "github-activity",
      owner: "brooswit-factory",
      dependsOn: [MANAGER_INTERNET_DEPENDENCY],
      quietThresholdMs: 60_000,
      timeoutMs: 1000,
    },
    ssh: { name: "ssh", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
    tunnelPing: { name: "tunnel-ping", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 },
    localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
    uptime: { host: "unused", timeoutMs: 1000 },
    daemon: { host: "unused", unit: "example.service", scope: "user", timeoutMs: 1000 },
    fleet: { host: "unused", processMatch: "claude", expectedFlags: ["--mcp-config"], timeoutMs: 1000 },
  };
}

function deps(config: RecoveryConfig, wedgeProbes: FakeWedgeProbes, recoveryProbes: FakeRecoveryProbes): RecoveryStatusDeps {
  return { loadConfig: () => config, createWedgeProbes: () => wedgeProbes, createRecoveryProbes: () => recoveryProbes };
}

describe("recoveryVerdictExitCode — a distinct exit code per verdict class", () => {
  test("RECOVERED maps to Ok (0)", () => {
    expect(recoveryVerdictExitCode(RecoveryVerdict.Recovered)).toBe(ExitCode.Ok);
  });
  test("each non-RECOVERED verdict maps to its own dedicated, distinct code", () => {
    const codes = [
      recoveryVerdictExitCode(RecoveryVerdict.NotRecovered),
      recoveryVerdictExitCode(RecoveryVerdict.FleetHalfRestored),
      recoveryVerdictExitCode(RecoveryVerdict.Inconclusive),
      recoveryVerdictExitCode(RecoveryVerdict.Unconfigured),
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(ExitCode.Ok);
  });
});

describe("runRecoveryStatus — never throws for a non-RECOVERED verdict (OUTCOME codes, not error codes)", () => {
  test("RECOVERED returns exit 0", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      sshHandler: async () => fakeDirectPathAlive(),
      tunnelPingHandler: async () => fakeDirectPathAlive(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: async () => fakeUptimeObserved(1000),
      daemonHandler: async () => fakeDaemonHealthy(),
      fleetAuditHandler: async () => fakeFleetEnumerated(1, 0),
    });
    const code = await runRecoveryStatus(deps(fullConfig(), wedgeProbes, recoveryProbes), true, SINCE, NOW);
    expect(code).toBe(ExitCode.Ok);
  });

  test("NOT_RECOVERED returns exit 13, no throw", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      sshHandler: async () => fakeDirectPathAlive(),
      tunnelPingHandler: async () => fakeDirectPathAlive(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: async () => fakeUptimeObserved(1000),
      daemonHandler: async () => fakeDaemonUnhealthy(),
      fleetAuditHandler: async () => fakeFleetEnumerated(1, 0),
    });
    const code = await runRecoveryStatus(deps(fullConfig(), wedgeProbes, recoveryProbes), false, SINCE, NOW);
    expect(code).toBe(ExitCode.RecoveryNotRecovered);
    expect(code).toBe(13);
  });

  test("FLEET_HALF_RESTORED returns exit 14, no throw", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      sshHandler: async () => fakeDirectPathAlive(),
      tunnelPingHandler: async () => fakeDirectPathAlive(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: async () => fakeUptimeObserved(1000),
      daemonHandler: async () => fakeDaemonHealthy(),
      fleetAuditHandler: async () => fakeFleetEnumerated(3, 2),
    });
    const code = await runRecoveryStatus(deps(fullConfig(), wedgeProbes, recoveryProbes), false, SINCE, NOW);
    expect(code).toBe(ExitCode.RecoveryFleetHalfRestored);
    expect(code).toBe(14);
  });

  test("INCONCLUSIVE returns exit 15, no throw", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      sshHandler: async () => fakeDirectPathDead(),
      tunnelPingHandler: async () => fakeDirectPathDead(),
      localConnectivityHandler: async () => fakeLocalControlUnhealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: async () => fakeUptimeObserved(1000),
      daemonHandler: async () => fakeDaemonHealthy(),
      fleetAuditHandler: async () => fakeFleetEnumerated(1, 0),
    });
    const code = await runRecoveryStatus(deps(fullConfig(), wedgeProbes, recoveryProbes), false, SINCE, NOW);
    expect(code).toBe(ExitCode.RecoveryInconclusive);
    expect(code).toBe(15);
  });

  test("UNCONFIGURED returns exit 16, no throw", async () => {
    const wedgeProbes = new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() });
    const recoveryProbes = new FakeRecoveryProbes();
    const config: RecoveryConfig = {
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
      uptime: undefined,
      daemon: undefined,
      fleet: undefined,
    };
    const code = await runRecoveryStatus(deps(config, wedgeProbes, recoveryProbes), false, SINCE, NOW);
    expect(code).toBe(ExitCode.RecoveryUnconfigured);
    expect(code).toBe(16);
  });
});

describe("toRecoveryStatusJson — the --json contract", () => {
  test("carries schemaVersion, command, verdict, since, elapsedMs, checks, and the full evidence trail — never a __brand field", () => {
    const result = evaluateRecovery({
      now: NOW,
      since: SINCE,
      reachability: [
        { __brand: "recovery-direct-path", name: "ssh", outcome: "alive", note: null },
        { __brand: "recovery-direct-path", name: "tunnel-ping", outcome: "alive", note: null },
      ],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      uptime: { __brand: "recovery-uptime", outcome: "observed", uptimeMs: 1000, note: null },
      daemon: { __brand: "recovery-daemon", outcome: "healthy", unit: "example.service", scope: "user", note: null },
      instruments: [
        { __brand: "recovery-instrument", name: "jira-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
        { __brand: "recovery-instrument", name: "github-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
      ],
      fleet: { __brand: "recovery-fleet", outcome: "enumerated", totalCandidates: 1, flaggedCount: 1, bareCount: 0, note: null },
    });
    const json = toRecoveryStatusJson(result, SINCE);
    expect(json.schemaVersion).toBe(1);
    expect(json.command).toBe("recovery status");
    expect(json.verdict).toBe(RecoveryVerdict.Recovered);
    expect(json.since).toBe(new Date(SINCE).toISOString());
    expect(json.elapsedMs).toBe(NOW - SINCE);
    expect(json.checks.reachability).toBe("pass");
    expect(JSON.stringify(json)).not.toContain("__brand");
  });

  test("instrument lastSeenAt is rendered as an ISO 8601 string, not a bare epoch number", () => {
    const result = evaluateRecovery({
      now: NOW,
      since: SINCE,
      reachability: [
        { __brand: "recovery-direct-path", name: "ssh", outcome: "not-configured", note: null },
        { __brand: "recovery-direct-path", name: "tunnel-ping", outcome: "not-configured", note: null },
      ],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      uptime: { __brand: "recovery-uptime", outcome: "not-configured", uptimeMs: null, note: null },
      daemon: { __brand: "recovery-daemon", outcome: "not-configured", unit: null, scope: null, note: null },
      instruments: [
        { __brand: "recovery-instrument", name: "jira-activity", outcome: "observed", lastSeenAt: SINCE + 5000, note: null },
        { __brand: "recovery-instrument", name: "github-activity", outcome: "not-configured", lastSeenAt: null, note: null },
      ],
      fleet: { __brand: "recovery-fleet", outcome: "not-configured", totalCandidates: null, flaggedCount: null, bareCount: null, note: null },
    });
    const json = toRecoveryStatusJson(result, SINCE);
    expect(json.instruments[0]!.lastSeenAt).toBe(new Date(SINCE + 5000).toISOString());
    expect(json.instruments[1]!.lastSeenAt).toBeNull();
  });
});

describe("formatRecoveryStatusHuman", () => {
  test("names the verdict, since, elapsed, and every check's PASS/FAIL/COULD-NOT-LOOK/NOT-CONFIGURED state", () => {
    const result = evaluateRecovery({
      now: NOW,
      since: SINCE,
      reachability: [
        { __brand: "recovery-direct-path", name: "ssh", outcome: "alive", note: null },
        { __brand: "recovery-direct-path", name: "tunnel-ping", outcome: "alive", note: null },
      ],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      uptime: { __brand: "recovery-uptime", outcome: "observed", uptimeMs: 1000, note: null },
      daemon: { __brand: "recovery-daemon", outcome: "healthy", unit: "example.service", scope: "user", note: null },
      instruments: [
        { __brand: "recovery-instrument", name: "jira-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
        { __brand: "recovery-instrument", name: "github-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
      ],
      fleet: { __brand: "recovery-fleet", outcome: "enumerated", totalCandidates: 1, flaggedCount: 1, bareCount: 0, note: null },
    });
    const text = formatRecoveryStatusHuman(result, SINCE);
    expect(text).toContain("Verdict: RECOVERED");
    expect(text).toContain(new Date(SINCE).toISOString());
    expect(text).toContain("PASS");
  });

  test("FLEET_HALF_RESTORED states plainly that wyzr does not fix this, so the reader does not wait for it to self-heal", () => {
    const result = evaluateRecovery({
      now: NOW,
      since: SINCE,
      reachability: [
        { __brand: "recovery-direct-path", name: "ssh", outcome: "alive", note: null },
        { __brand: "recovery-direct-path", name: "tunnel-ping", outcome: "alive", note: null },
      ],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      uptime: { __brand: "recovery-uptime", outcome: "observed", uptimeMs: 1000, note: null },
      daemon: { __brand: "recovery-daemon", outcome: "healthy", unit: "example.service", scope: "user", note: null },
      instruments: [
        { __brand: "recovery-instrument", name: "jira-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
        { __brand: "recovery-instrument", name: "github-activity", outcome: "observed", lastSeenAt: SINCE + 1000, note: null },
      ],
      fleet: { __brand: "recovery-fleet", outcome: "enumerated", totalCandidates: 3, flaggedCount: 1, bareCount: 2, note: null },
    });
    const text = formatRecoveryStatusHuman(result, SINCE);
    expect(text).toContain("Verdict: FLEET_HALF_RESTORED");
    expect(text.toLowerCase()).toContain("does not fix it");
  });
});

describe("defaultRecoveryStatusDeps — the real (production) wiring, exercised only for construction, never invoked", () => {
  test("createWedgeProbes() constructs a RealWedgeProbes", () => {
    expect(defaultRecoveryStatusDeps.createWedgeProbes()).toBeInstanceOf(RealWedgeProbes);
  });

  test("createRecoveryProbes() constructs a RealRecoveryProbes", () => {
    expect(defaultRecoveryStatusDeps.createRecoveryProbes()).toBeInstanceOf(RealRecoveryProbes);
  });

  test("loadConfig() returns a RecoveryConfig with at least localConnectivity populated", () => {
    const config = defaultRecoveryStatusDeps.loadConfig();
    expect(config.localConnectivity).toBeDefined();
  });
});
