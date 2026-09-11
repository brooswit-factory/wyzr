// A first-class fake implementation of RecoveryProbes
// (src/recovery-probes.ts), shipped alongside the real one
// (src/recovery-probes-real.ts), for exercising every code path with NO
// network and NO subprocess. Same shape as src/wedge-probes-fake.ts's
// FakeWedgeProbes: a handler override per method, each defaulting to a
// plain, clearly-labeled reading.
//
// All fixtures here are SYNTHETIC (tier (d)) — none of these three probes
// has ever run against a real box; see README's "wyzr recovery status"
// section, "What has never been run against reality."

import type {
  DaemonProbeConfig,
  FleetAuditConfig,
  RawDaemonReading,
  RawFleetAuditReading,
  RawUptimeReading,
  RecoveryProbes,
  UptimeProbeConfig,
} from "./recovery-probes.ts";

export type Handler<Config, Reading> = (config: Config) => Reading | Promise<Reading>;

export interface FakeRecoveryProbesOptions {
  uptimeHandler?: Handler<UptimeProbeConfig, RawUptimeReading>;
  daemonHandler?: Handler<DaemonProbeConfig, RawDaemonReading>;
  fleetAuditHandler?: Handler<FleetAuditConfig, RawFleetAuditReading>;
}

export function fakeUptimeObserved(uptimeMs: number): RawUptimeReading {
  return { outcome: "observed", uptimeMs, note: null };
}
export function fakeUptimeError(note: string | null = "the uptime probe itself failed"): RawUptimeReading {
  return { outcome: "error", uptimeMs: null, note };
}

export function fakeDaemonHealthy(): RawDaemonReading {
  return { outcome: "healthy", note: null };
}
export function fakeDaemonUnhealthy(note: string | null = 'ActiveState is "inactive", not "active"'): RawDaemonReading {
  return { outcome: "unhealthy", note };
}
export function fakeDaemonPointedAtNothing(
  note: string | null = 'systemd reports this unit\'s LoadState as "not-found"',
): RawDaemonReading {
  return { outcome: "pointed-at-nothing", note };
}
export function fakeDaemonError(note: string | null = "the daemon-check probe itself failed"): RawDaemonReading {
  return { outcome: "error", note };
}

export function fakeFleetEnumerated(totalCandidates: number, bareCount: number): RawFleetAuditReading {
  return {
    outcome: "enumerated",
    totalCandidates,
    flaggedCount: totalCandidates - bareCount,
    bareCount,
    note: null,
  };
}
export function fakeFleetError(note: string | null = "the fleet-audit probe itself failed"): RawFleetAuditReading {
  return { outcome: "error", totalCandidates: null, flaggedCount: null, bareCount: null, note };
}

export class FakeRecoveryProbes implements RecoveryProbes {
  constructor(private readonly opts: FakeRecoveryProbesOptions = {}) {}

  async checkUptime(config: UptimeProbeConfig): Promise<RawUptimeReading> {
    return this.opts.uptimeHandler ? await this.opts.uptimeHandler(config) : fakeUptimeObserved(0);
  }

  async checkDaemon(config: DaemonProbeConfig): Promise<RawDaemonReading> {
    return this.opts.daemonHandler ? await this.opts.daemonHandler(config) : fakeDaemonHealthy();
  }

  async checkFleetAudit(config: FleetAuditConfig): Promise<RawFleetAuditReading> {
    return this.opts.fleetAuditHandler ? await this.opts.fleetAuditHandler(config) : fakeFleetEnumerated(1, 0);
  }
}
