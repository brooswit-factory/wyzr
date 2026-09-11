import { describe, expect, test } from "bun:test";
import { redact, resetSecretsForTesting } from "../../src/redact.ts";
import { RecoveryVerdict } from "../../src/recovery.ts";
import { runRecoveryCheck } from "../../src/recovery-runner.ts";
import { FakeWedgeProbes, fakeDirectPathAlive, fakeLocalControlHealthy } from "../../src/wedge-probes-fake.ts";
import { FakeRecoveryProbes, fakeDaemonHealthy, fakeFleetEnumerated, fakeUptimeObserved } from "../../src/recovery-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY } from "../../src/wedge-config.ts";
import type { RecoveryConfig } from "../../src/recovery-config.ts";

const SINCE = 1_800_000_000_000;
const NOW = SINCE + 100_000;

function baseConfig(overrides: Partial<RecoveryConfig> = {}): RecoveryConfig {
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
    uptime: { host: "unused", timeoutMs: 1000 },
    daemon: { host: "unused", unit: "example.service", scope: "user", timeoutMs: 1000 },
    fleet: { host: "unused", processMatch: "claude", expectedFlags: ["--mcp-config"], timeoutMs: 1000 },
    ...overrides,
  };
}

describe("runRecoveryCheck — assembly of a full run through the injectable boundary", () => {
  test("a fully wired, all-good run reaches RECOVERED", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: SINCE + 1000, note: null }),
      sshHandler: async () => fakeDirectPathAlive(),
      tunnelPingHandler: async () => fakeDirectPathAlive(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: async () => fakeUptimeObserved(50_000),
      daemonHandler: async () => fakeDaemonHealthy(),
      fleetAuditHandler: async () => fakeFleetEnumerated(2, 0),
    });
    const result = await runRecoveryCheck({ config: baseConfig(), wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    expect(result.verdict).toBe(RecoveryVerdict.Recovered);
    expect(result.reachability).toHaveLength(2);
    expect(result.instruments).toHaveLength(2);
  });

  test(
    "named test 16: every field unconfigured except the always-present local-connectivity control — UNCONFIGURED, " +
      "never throws, and EVERY slot still reports itself unconfigured rather than vanishing",
    async () => {
      const wedgeProbes = new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() });
      const recoveryProbes = new FakeRecoveryProbes();
      const config = baseConfig({ jira: undefined, github: undefined, ssh: undefined, tunnelPing: undefined, uptime: undefined, daemon: undefined, fleet: undefined });
      const result = await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
      expect(result.verdict).toBe(RecoveryVerdict.Unconfigured);

      // Both reachability slots still appear, each explicitly unconfigured —
      // never absent from the evidence trail.
      expect(result.reachability).toHaveLength(2);
      for (const p of result.reachability) expect(p.outcome).toBe("not-configured");

      // Both instrument slots too.
      expect(result.instruments).toHaveLength(2);
      for (const i of result.instruments) expect(i.outcome).toBe("not-configured");

      expect(result.uptime.outcome).toBe("not-configured");
      expect(result.daemon.outcome).toBe("not-configured");
      expect(result.fleet.outcome).toBe("not-configured");
    },
  );

  test("a probe that throws is reported as an error observation, never left to crash the run", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      sshHandler: async () => {
        throw new Error("boom");
      },
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes();
    const result = await runRecoveryCheck({ config: baseConfig(), wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    const ssh = result.reachability.find((p) => p.name === "ssh");
    expect(ssh?.outcome).toBe("unconfirmed");
    expect(ssh?.note).toBe("boom");
  });

  test("a probe that never settles is reported as a timeout, never hangs the run", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      sshHandler: () => new Promise(() => {}), // never resolves
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes();
    const config = baseConfig({ ssh: { name: "ssh", host: "unused", timeoutMs: 10, connectTimeoutMs: 5 } });
    const result = await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    const ssh = result.reachability.find((p) => p.name === "ssh");
    expect(ssh?.outcome).toBe("unconfirmed");
  });

  test("every new probe's timeout/error branch is reachable through the runner (not just default-fake-happy-path)", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      localConnectivityHandler: () => new Promise(() => {}), // never resolves -> timeout
      gitHubHandler: async () => {
        throw new Error("github boom");
      },
    });
    const recoveryProbes = new FakeRecoveryProbes({
      uptimeHandler: () => new Promise(() => {}), // never resolves -> timeout
      daemonHandler: async () => {
        throw new Error("daemon boom");
      },
      fleetAuditHandler: () => new Promise(() => {}), // never resolves -> timeout
    });
    const config = baseConfig({
      localConnectivity: { ...DEFAULT_LOCAL_CONNECTIVITY_CONFIG, timeoutMs: 5 },
      uptime: { host: "unused", timeoutMs: 5 },
      fleet: { host: "unused", processMatch: "claude", expectedFlags: ["--mcp-config"], timeoutMs: 5 },
    });
    const result = await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: SINCE, now: NOW });

    expect(result.localControl.outcome).toBe("timeout");
    expect(result.uptime.outcome).toBe("timeout");
    expect(result.daemon.outcome).toBe("error");
    expect(result.daemon.note).toBe("daemon boom");
    expect(result.fleet.outcome).toBe("timeout");
    const github = result.instruments.find((i) => i.name === "github-activity");
    expect(github?.outcome).toBe("error");
    expect(github?.note).toBe("github boom");
  });

  test("a probe that never settles for an instrument is reported as a timeout", async () => {
    const wedgeProbes = new FakeWedgeProbes({
      jiraHandler: () => new Promise(() => {}), // never resolves
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const recoveryProbes = new FakeRecoveryProbes();
    const config = baseConfig({
      jira: {
        name: "jira-activity",
        baseUrl: "https://example-not-real.atlassian.net",
        authHeader: "Basic fake",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 5,
      },
    });
    const result = await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    const jira = result.instruments.find((i) => i.name === "jira-activity");
    expect(jira?.outcome).toBe("timeout");
  });

  test("elapsedMs is now - since, threaded through from the injected clock", async () => {
    const wedgeProbes = new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() });
    const recoveryProbes = new FakeRecoveryProbes();
    const result = await runRecoveryCheck({ config: baseConfig(), wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    expect(result.elapsedMs).toBe(NOW - SINCE);
  });

  test("jira authHeader and github token are registered with the redaction registry before any probe runs", async () => {
    resetSecretsForTesting();
    const wedgeProbes = new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() });
    const recoveryProbes = new FakeRecoveryProbes();
    const config = baseConfig({
      jira: {
        name: "jira-activity",
        baseUrl: "https://example-not-real.atlassian.net",
        authHeader: "Basic super-secret-token-xyz",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 1000,
      },
      github: {
        name: "github-activity",
        owner: "brooswit-factory",
        token: "ghp_super_secret_token_abc",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 1000,
      },
    });
    await runRecoveryCheck({ config, wedgeProbes, recoveryProbes, since: SINCE, now: NOW });
    expect(redact("token was: Basic super-secret-token-xyz")).not.toContain("super-secret-token-xyz");
    expect(redact("token was: ghp_super_secret_token_abc")).not.toContain("ghp_super_secret_token_abc");
    resetSecretsForTesting();
  });
});
