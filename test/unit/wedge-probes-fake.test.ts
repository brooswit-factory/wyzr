import { describe, expect, test } from "bun:test";
import {
  FakeWedgeProbes,
  fakeControlPlaneReading,
  fakeDirectPathAlive,
  fakeDirectPathDead,
  fakeDirectPathUnconfirmed,
  fakeGitHubActivityReading,
  fakeJiraActivityReading,
  fakeLocalControlError,
  fakeLocalControlHealthy,
  fakeLocalControlUnhealthy,
} from "../../src/wedge-probes-fake.ts";
import type {
  ControlPlaneConfig,
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "../../src/wedge-probes.ts";

const JIRA_CONFIG: JiraInstrumentConfig = {
  name: "jira-activity",
  baseUrl: "unused",
  authHeader: "unused",
  dependsOn: [],
  quietThresholdMs: 1000,
  timeoutMs: 1000,
};
const GITHUB_CONFIG: GitHubInstrumentConfig = {
  name: "github-activity",
  owner: "unused",
  dependsOn: [],
  quietThresholdMs: 1000,
  timeoutMs: 1000,
};
const PATH_CONFIG: DirectPathConfig = { name: "path", host: "unused", timeoutMs: 1000, connectTimeoutMs: 500 };
const LOCAL_CONFIG: LocalConnectivityConfig = { name: "local", target: "unused", timeoutMs: 1000, confirms: [] };
const CONTROL_PLANE_CONFIG: ControlPlaneConfig = { name: "control-plane", timeoutMs: 1000 };

describe("individual fixture helpers", () => {
  test("fakeJiraActivityReading/fakeGitHubActivityReading produce an 'observed' reading at the given timestamp", () => {
    expect(fakeJiraActivityReading(12345)).toEqual({ outcome: "observed", lastSeenAt: 12345, note: null });
    expect(fakeGitHubActivityReading(6789)).toEqual({ outcome: "observed", lastSeenAt: 6789, note: null });
  });

  test("the three direct-path fixtures produce their respective outcomes", () => {
    expect(fakeDirectPathDead().outcome).toBe("dead");
    expect(fakeDirectPathAlive().outcome).toBe("alive");
    expect(fakeDirectPathUnconfirmed().outcome).toBe("unconfirmed");
  });

  test("the three local-control fixtures produce their respective outcomes", () => {
    expect(fakeLocalControlHealthy().outcome).toBe("healthy");
    expect(fakeLocalControlUnhealthy().outcome).toBe("unhealthy");
    expect(fakeLocalControlError().outcome).toBe("error");
  });

  test("fakeControlPlaneReading defaults to online, and accepts an override", () => {
    expect(fakeControlPlaneReading().online).toBe(true);
    expect(fakeControlPlaneReading(false).online).toBe(false);
    expect(fakeControlPlaneReading("unknown").online).toBe("unknown");
  });
});

describe("FakeWedgeProbes — defaults (no handler override)", () => {
  test("checkJiraActivity defaults to an observed reading", async () => {
    const probes = new FakeWedgeProbes();
    const reading = await probes.checkJiraActivity(JIRA_CONFIG);
    expect(reading.outcome).toBe("observed");
  });

  test("checkGitHubActivity defaults to an observed reading", async () => {
    const probes = new FakeWedgeProbes();
    const reading = await probes.checkGitHubActivity(GITHUB_CONFIG);
    expect(reading.outcome).toBe("observed");
  });

  test("checkSsh/checkTunnelPing default to alive", async () => {
    const probes = new FakeWedgeProbes();
    expect((await probes.checkSsh(PATH_CONFIG)).outcome).toBe("alive");
    expect((await probes.checkTunnelPing(PATH_CONFIG)).outcome).toBe("alive");
  });

  test("checkLocalConnectivity defaults to healthy", async () => {
    const probes = new FakeWedgeProbes();
    expect((await probes.checkLocalConnectivity(LOCAL_CONFIG)).outcome).toBe("healthy");
  });

  test("checkControlPlane defaults to online", async () => {
    const probes = new FakeWedgeProbes();
    expect((await probes.checkControlPlane(CONTROL_PLANE_CONFIG)).online).toBe(true);
  });
});
