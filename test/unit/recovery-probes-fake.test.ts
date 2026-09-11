import { describe, expect, test } from "bun:test";
import {
  fakeDaemonError,
  fakeDaemonHealthy,
  fakeDaemonPointedAtNothing,
  fakeDaemonUnhealthy,
  fakeFleetEnumerated,
  fakeFleetError,
  fakeUptimeError,
  fakeUptimeObserved,
  FakeRecoveryProbes,
} from "../../src/recovery-probes-fake.ts";
import type { DaemonProbeConfig, FleetAuditConfig, UptimeProbeConfig } from "../../src/recovery-probes.ts";

const UPTIME_CONFIG: UptimeProbeConfig = { host: "example-not-real.invalid", timeoutMs: 5000 };
const DAEMON_CONFIG: DaemonProbeConfig = { host: "example-not-real.invalid", unit: "example.service", scope: "user", timeoutMs: 5000 };
const FLEET_CONFIG: FleetAuditConfig = {
  host: "example-not-real.invalid",
  processMatch: "claude",
  expectedFlags: ["--mcp-config"],
  timeoutMs: 5000,
};

describe("fixture builders", () => {
  test("fakeUptimeObserved / fakeUptimeError", () => {
    expect(fakeUptimeObserved(1000)).toEqual({ outcome: "observed", uptimeMs: 1000, note: null });
    expect(fakeUptimeError().outcome).toBe("error");
  });

  test("fakeDaemonHealthy / fakeDaemonUnhealthy / fakeDaemonPointedAtNothing / fakeDaemonError", () => {
    expect(fakeDaemonHealthy().outcome).toBe("healthy");
    expect(fakeDaemonUnhealthy().outcome).toBe("unhealthy");
    expect(fakeDaemonPointedAtNothing().outcome).toBe("pointed-at-nothing");
    expect(fakeDaemonError().outcome).toBe("error");
  });

  test("fakeFleetEnumerated computes flaggedCount from totalCandidates - bareCount", () => {
    const reading = fakeFleetEnumerated(5, 2);
    expect(reading).toEqual({ outcome: "enumerated", totalCandidates: 5, flaggedCount: 3, bareCount: 2, note: null });
  });

  test("fakeFleetError", () => {
    expect(fakeFleetError().outcome).toBe("error");
    expect(fakeFleetError().totalCandidates).toBeNull();
  });
});

describe("FakeRecoveryProbes — default readings with no handler override", () => {
  test("checkUptime defaults to an observed 0ms reading", async () => {
    const probes = new FakeRecoveryProbes();
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("observed");
  });

  test("checkDaemon defaults to healthy", async () => {
    const probes = new FakeRecoveryProbes();
    const reading = await probes.checkDaemon(DAEMON_CONFIG);
    expect(reading.outcome).toBe("healthy");
  });

  test("checkFleetAudit defaults to one fully-flagged candidate", async () => {
    const probes = new FakeRecoveryProbes();
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.outcome).toBe("enumerated");
    expect(reading.bareCount).toBe(0);
  });
});

describe("FakeRecoveryProbes — handler overrides are honored, and receive the config", () => {
  test("checkUptime handler override", async () => {
    const probes = new FakeRecoveryProbes({ uptimeHandler: (config) => fakeUptimeObserved(config.timeoutMs) });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.uptimeMs).toBe(UPTIME_CONFIG.timeoutMs);
  });

  test("checkDaemon handler override", async () => {
    const probes = new FakeRecoveryProbes({ daemonHandler: () => fakeDaemonUnhealthy() });
    const reading = await probes.checkDaemon(DAEMON_CONFIG);
    expect(reading.outcome).toBe("unhealthy");
  });

  test("checkFleetAudit handler override, and an async handler is awaited", async () => {
    const probes = new FakeRecoveryProbes({ fleetAuditHandler: async () => fakeFleetEnumerated(4, 1) });
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.totalCandidates).toBe(4);
    expect(reading.bareCount).toBe(1);
  });
});
