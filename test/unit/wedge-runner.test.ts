import { describe, expect, test } from "bun:test";
import { redact, resetSecretsForTesting } from "../../src/redact.ts";
import { WedgeVerdict } from "../../src/wedge.ts";
import { runWedgeCheck } from "../../src/wedge-runner.ts";
import {
  FakeWedgeProbes,
  fakeDirectPathAlive,
  fakeDirectPathDead,
  fakeLocalControlHealthy,
} from "../../src/wedge-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY, type WedgeConfig } from "../../src/wedge-config.ts";

const NOW = 1_800_000_000_000;

function baseConfig(overrides: Partial<WedgeConfig> = {}): WedgeConfig {
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
    controlPlane: { name: "tailscale", timeoutMs: 1000 },
    ...overrides,
  };
}

describe("runWedgeCheck — assembly of a full run through the injectable boundary", () => {
  test("a fully wired, all-silent, all-dead, healthy-control run reaches PROVEN", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      sshHandler: async () => fakeDirectPathDead(),
      tunnelPingHandler: async () => fakeDirectPathDead(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const result = await runWedgeCheck({ config: baseConfig(), probes, now: NOW });
    expect(result.verdict).toBe(WedgeVerdict.Proven);
    expect(result.instruments).toHaveLength(2);
    expect(result.directPaths).toHaveLength(2);
    expect(result.controlPlane).toHaveLength(1);
  });

  test("every field unconfigured except the always-present local-connectivity control: NOT_PROVEN, never throws, and every slot still reports itself unconfigured", async () => {
    const probes = new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() });
    const config = baseConfig({
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: undefined,
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
    // Unconfigured never means "absent from the evidence trail" — see
    // src/wedge-runner.ts's own comment on this. Both instrument slots and
    // both direct-path slots still appear, each explicitly unconfigured.
    expect(result.instruments).toHaveLength(2);
    expect(result.instruments.every((i) => i.outcome === "unconfigured")).toBe(true);
    expect(result.instruments.map((i) => i.name).toSorted()).toEqual(["github-activity", "jira-activity"]);
    expect(result.directPaths).toHaveLength(2);
    expect(result.directPaths.every((p) => p.outcome === "unconfirmed")).toBe(true);
    expect(result.directPaths.map((p) => p.name).toSorted()).toEqual(["ssh", "tunnel-ping"]);
    // Control-plane, unlike instruments/direct-paths, has no quorum role
    // and is genuinely optional — it is absent, not an "unconfigured" row.
    expect(result.controlPlane).toHaveLength(0);
  });

  test("a probe that never settles is reported as timeout, not left hanging forever", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: () => new Promise(() => {}), // never resolves
    });
    const config = baseConfig({
      jira: {
        name: "jira-activity",
        baseUrl: "https://example-not-real.atlassian.net",
        authHeader: "Basic fake-secret-abc123",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 25, // short so this test stays fast — the value itself is not under test
      },
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: undefined,
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    const jira = result.instruments.find((i) => i.name === "jira-activity")!;
    expect(jira.outcome).toBe("timeout");
    expect(jira.isSilent).toBe(false);
  });

  test("a probe that throws synchronously is caught and reported as error, never crashes the run", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => {
        throw new Error("boom");
      },
    });
    const config = baseConfig({ github: undefined, ssh: undefined, tunnelPing: undefined, controlPlane: undefined });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    const jira = result.instruments.find((i) => i.name === "jira-activity")!;
    expect(jira.outcome).toBe("error");
  });

  test("direct-path 'alive' is passed through, correctly blocking PROVEN even with everything else satisfied", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      sshHandler: async () => fakeDirectPathAlive(),
      tunnelPingHandler: async () => fakeDirectPathDead(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const result = await runWedgeCheck({ config: baseConfig(), probes, now: NOW });
    expect(result.verdict).toBe(WedgeVerdict.NotProven);
  });

  test("jira authHeader and github token are registered for redaction before any probe runs", async () => {
    resetSecretsForTesting();
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
    });
    const config = baseConfig({
      jira: {
        name: "jira-activity",
        baseUrl: "https://example-not-real.atlassian.net",
        authHeader: "Basic redact-me-secret-999",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 1000,
      },
      github: {
        name: "github-activity",
        owner: "brooswit-factory",
        token: "redact-me-token-888",
        dependsOn: [MANAGER_INTERNET_DEPENDENCY],
        quietThresholdMs: 60_000,
        timeoutMs: 1000,
      },
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: undefined,
    });
    await runWedgeCheck({ config, probes, now: NOW });
    expect(redact("leaked: Basic redact-me-secret-999")).not.toContain("redact-me-secret-999");
    expect(redact("leaked: redact-me-token-888")).not.toContain("redact-me-token-888");
    resetSecretsForTesting();
  });

  test("a probe that resolves with a non-'observed' RawInstrumentReading (not thrown) is passed through as-is", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "error", lastSeenAt: null, note: "Jira responded with HTTP 500" }),
    });
    const config = baseConfig({ github: undefined, ssh: undefined, tunnelPing: undefined, controlPlane: undefined });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    const jira = result.instruments.find((i) => i.name === "jira-activity")!;
    expect(jira.outcome).toBe("error");
    expect(jira.note).toBe("Jira responded with HTTP 500");
  });

  test("a direct-path probe that never settles is reported unconfirmed (this budget's own timeout), not left hanging", async () => {
    const probes = new FakeWedgeProbes({ sshHandler: () => new Promise(() => {}) });
    const config = baseConfig({
      jira: undefined,
      github: undefined,
      ssh: { name: "ssh", host: "unused", timeoutMs: 25, connectTimeoutMs: 500 },
      tunnelPing: undefined,
      controlPlane: undefined,
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    const ssh = result.directPaths.find((p) => p.name === "ssh")!;
    expect(ssh.outcome).toBe("unconfirmed");
  });

  test("a direct-path probe that throws is caught and reported unconfirmed, never crashes the run", async () => {
    const probes = new FakeWedgeProbes({
      sshHandler: async () => {
        throw new Error("boom");
      },
    });
    const config = baseConfig({ jira: undefined, github: undefined, tunnelPing: undefined, controlPlane: undefined });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    const ssh = result.directPaths.find((p) => p.name === "ssh")!;
    expect(ssh.outcome).toBe("unconfirmed");
    expect(ssh.note).toBe("boom");
  });

  test("the local-connectivity control never settling is reported as its own timeout outcome, not left hanging", async () => {
    const probes = new FakeWedgeProbes({ localConnectivityHandler: () => new Promise(() => {}) });
    const config = baseConfig({
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: undefined,
      localConnectivity: { ...DEFAULT_LOCAL_CONNECTIVITY_CONFIG, timeoutMs: 25 },
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    expect(result.localControl.outcome).toBe("timeout");
  });

  test("the local-connectivity control throwing is caught and reported as its own error outcome", async () => {
    const probes = new FakeWedgeProbes({
      localConnectivityHandler: async () => {
        throw new Error("ping ENOENT");
      },
    });
    const config = baseConfig({ jira: undefined, github: undefined, ssh: undefined, tunnelPing: undefined, controlPlane: undefined });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    expect(result.localControl.outcome).toBe("error");
    expect(result.localControl.note).toBe("ping ENOENT");
  });

  test("a control-plane probe that never settles is reported as an unknown reading, not left hanging (this is informational only, never blocks the run)", async () => {
    const probes = new FakeWedgeProbes({ controlPlaneHandler: () => new Promise(() => {}) });
    const config = baseConfig({
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: { name: "tailscale", timeoutMs: 25 },
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    expect(result.controlPlane).toHaveLength(1);
    expect(result.controlPlane[0]!.online).toBe("unknown");
  });

  test("a control-plane probe that throws is caught and reported as an unknown reading, never crashes the run", async () => {
    const probes = new FakeWedgeProbes({
      controlPlaneHandler: async () => {
        throw new Error("tailscale ENOENT");
      },
    });
    const config = baseConfig({
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      controlPlane: { name: "tailscale", timeoutMs: 1000 },
    });
    const result = await runWedgeCheck({ config, probes, now: NOW });
    expect(result.controlPlane).toHaveLength(1);
    expect(result.controlPlane[0]!.online).toBe("unknown");
  });
});
