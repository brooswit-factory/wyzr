// The real implementation of RecoveryProbes (src/recovery-probes.ts):
// shells out over ssh to the suspect box for all three probes. Every
// I/O-performing primitive is INJECTABLE (`runCapturing`, defaulting to
// src/wedge-probes-real.ts's own `defaultRunCapturing` — reused rather than
// duplicated, same Bun.spawn-based implementation this repo already ships
// and tests) so request construction and response classification can be
// unit-tested with NO network and NO subprocess. Same shape as
// src/wedge-probes-real.ts's own RealWedgeProbes.
//
// Every probe method below CATCHES its own failures and returns a
// classified RawXReading rather than throwing — src/recovery-runner.ts's
// own attempt() wrapper (reused from src/wedge-runner.ts) is a defensive
// backstop for a genuinely unexpected throw, not this module's primary
// error path.
//
// DESIGN DECISIONS THIS TICKET LEFT OPEN, RESOLVED HERE (stated so a later
// reader can re-derive WHY rather than take them on faith — the ticket's own
// "put the reasoning in the code, not just the rule" requirement):
//
// 1. HOW THE UPTIME DURATION IS OBTAINED: `cat /proc/uptime` over ssh. Its
//    FIRST field is seconds since boot, read from the kernel's own
//    monotonic clock — never the wall clock — which is exactly the
//    skew-immune DURATION src/recovery.ts's reboot check needs (see that
//    module's own comment for the full reasoning: comparing this duration
//    against the manager's own elapsed-since-cut duration is two
//    single-clock measurements, never a cross-machine INSTANT comparison,
//    so neither side's wall-clock skew can produce a false PASS or a false
//    FAIL). This is Linux-specific — documented in README as exactly that,
//    not a portability guarantee. A reading this probe cannot PARSE is
//    reported as `"error"` (never a pass, never a fail — "could not look")
//    rather than ever falling back to a wall-clock method (`who -b`), which
//    would reintroduce the skew hazard this design exists to remove.
// 2. HOW THE DAEMON CHECK DISTINGUISHES "POINTED AT NOTHING": `systemctl
//    [--user] show <unit> --property=LoadState,ActiveState --no-pager` over
//    ssh, keying on `LoadState=not-found` — deliberately NOT
//    `journalctl -u <unit>`. This sidesteps this fleet's own documented
//    sharp edge (a system-level `journalctl -u <unit>` against a USER unit
//    prints "-- No entries --", not an error — an empty log, not a wrong
//    command) entirely, rather than working around it: `systemctl show`
//    reports LoadState regardless of scope mismatch, so a wrong scope
//    reads as `"pointed-at-nothing"`, never as a silently-empty "healthy"
//    or "unhealthy" reading. `systemctl show` against a genuinely
//    nonexistent unit exits 0 (not nonzero) with `LoadState=not-found` in
//    its output — this is why classification below reads OUTPUT CONTENT,
//    never relies on the ssh/systemctl exit code alone to distinguish
//    "not found" from "found and unhealthy."
// 3. THE FLEET-AUDIT ENUMERATION TRAP (relayed on the ticket, 2026-09-10,
//    from a real run against a live multi-agent box): a bare-restored
//    pane's argv carries none of `expectedFlags` at all (the whole point of
//    the trap — a healthy pane's workspace path lives INSIDE one of the
//    missing flags), so the CANDIDATE SET is built from `processMatch`
//    (something every candidate, bare or not, still has — e.g. the binary
//    name) over the raw process list, and `expectedFlags` is applied only
//    AFTER that set exists, never as part of building it. Getting this
//    backwards is exactly the failure mode the relayed run demonstrated:
//    "N of N healthy," forever, on a fleet that is half bare.
// 4. THE REDACTION-SAFETY BOUNDARY FOR THE FLEET AUDIT: `ps -eo args=`'s
//    raw output is read ONLY inside `checkFleetAudit()` below and handed
//    ONLY to the pure `classifyFleetProcesses()` classifier, which returns
//    COUNTS ONLY (src/recovery-probes.ts's `RawFleetAuditReading` has no
//    field a raw argv string, pid, or session id could occupy). The raw
//    `CaptureResult.stdout` is never touched again after that one call, on
//    ANY path — including this function's own error paths, which report a
//    fixed, fragment-safe string, never `result.stdout` or any slice of it.

import {
  defaultRunCapturing,
  type CaptureResult,
  type RunCapturingLike,
} from "./wedge-probes-real.ts";
import type {
  DaemonProbeConfig,
  FleetAuditConfig,
  RawDaemonReading,
  RawFleetAuditReading,
  RawUptimeReading,
  RecoveryProbes,
  UptimeProbeConfig,
} from "./recovery-probes.ts";

function connectSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

function sshArgs(host: string, timeoutMs: number, remoteCmd: readonly string[]): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectSeconds(timeoutMs)}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    host,
    ...remoteCmd,
  ];
}

/**
 * Parses `/proc/uptime`'s first field (seconds since boot, on the kernel's
 * own monotonic clock — see this module's top comment, decision 1) into
 * milliseconds. `null` on anything unparseable — a caller must treat that as
 * "could not look," never a pass or a fail.
 */
export function parseUptimeSeconds(raw: string): number | null {
  const first = raw.trim().split(/\s+/)[0];
  if (!first) return null;
  const seconds = Number(first);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Classifies `systemctl show ... --property=LoadState,ActiveState`'s output
 * — see this module's top comment, decision 2, for why THIS command (never
 * `journalctl`) and why it reads output content rather than the exit code.
 */
export function classifyDaemonOutput(stdout: string): RawDaemonReading {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const loadState = props["LoadState"];
  const activeState = props["ActiveState"];

  if (loadState === "not-found") {
    return {
      outcome: "pointed-at-nothing",
      note: 'systemd reports this unit\'s LoadState as "not-found" — the configured unit/scope does not point at anything that exists',
    };
  }
  if (loadState === undefined || activeState === undefined) {
    return {
      outcome: "error",
      note: "systemctl's output did not include the expected LoadState/ActiveState properties",
    };
  }
  if (activeState === "active") {
    return { outcome: "healthy", note: null };
  }
  return { outcome: "unhealthy", note: `unit is loaded but ActiveState is "${activeState}", not "active"` };
}

/**
 * COUNTS the candidate set built from `processMatch` (see this module's top
 * comment, decision 3, for why the candidate set must never be built from
 * `expectedFlags`) and classifies each candidate as "flagged" (carries
 * EVERY string in `expectedFlags`) or "bare." Receives raw process-list
 * text as input but returns ONLY numbers — see this module's top comment,
 * decision 4, and src/recovery-probes.ts's `RawFleetAuditReading` for the
 * structural half of this guarantee. `test/unit/recovery-probes-real.test.ts`
 * feeds this a fixture containing a session-id-shaped string and asserts it
 * appears nowhere in the returned object (named test, per the ticket).
 */
export function classifyFleetProcesses(
  rawPsOutput: string,
  processMatch: string,
  expectedFlags: readonly string[],
): { totalCandidates: number; flaggedCount: number; bareCount: number } {
  const candidates = rawPsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(processMatch));

  let flaggedCount = 0;
  for (const line of candidates) {
    if (expectedFlags.every((flag) => line.includes(flag))) flaggedCount++;
  }
  return { totalCandidates: candidates.length, flaggedCount, bareCount: candidates.length - flaggedCount };
}

export interface RealRecoveryProbesOptions {
  runCapturing?: RunCapturingLike;
}

export class RealRecoveryProbes implements RecoveryProbes {
  private readonly runCapturing: RunCapturingLike;

  constructor(opts: RealRecoveryProbesOptions = {}) {
    this.runCapturing = opts.runCapturing ?? defaultRunCapturing;
  }

  async checkUptime(config: UptimeProbeConfig): Promise<RawUptimeReading> {
    let result: CaptureResult;
    try {
      result = await this.runCapturing(sshArgs(config.host, config.timeoutMs, ["cat", "/proc/uptime"]), config.timeoutMs);
    } catch {
      return { outcome: "error", uptimeMs: null, note: "could not run the uptime probe at all (e.g. ssh not on PATH)" };
    }
    if (result.timedOut) {
      return { outcome: "timeout", uptimeMs: null, note: "the uptime probe did not complete within its configured timeout" };
    }
    if (result.exitCode !== 0) {
      return { outcome: "error", uptimeMs: null, note: `the uptime ssh probe exited ${result.exitCode}` };
    }
    const seconds = parseUptimeSeconds(result.stdout);
    if (seconds === null) {
      return { outcome: "error", uptimeMs: null, note: "could not parse /proc/uptime's output as this project expected" };
    }
    return { outcome: "observed", uptimeMs: seconds * 1000, note: null };
  }

  async checkDaemon(config: DaemonProbeConfig): Promise<RawDaemonReading> {
    const remoteCmd = [
      "systemctl",
      ...(config.scope === "user" ? ["--user"] : []),
      "show",
      config.unit,
      "--property=LoadState,ActiveState",
      "--no-pager",
    ];
    let result: CaptureResult;
    try {
      result = await this.runCapturing(sshArgs(config.host, config.timeoutMs, remoteCmd), config.timeoutMs);
    } catch {
      return { outcome: "error", note: "could not run the daemon-check probe at all (e.g. ssh not on PATH)" };
    }
    if (result.timedOut) {
      return { outcome: "timeout", note: "the daemon-check probe did not complete within its configured timeout" };
    }
    if (result.exitCode !== 0) {
      return { outcome: "error", note: `the daemon-check ssh probe exited ${result.exitCode}` };
    }
    return classifyDaemonOutput(result.stdout);
  }

  async checkFleetAudit(config: FleetAuditConfig): Promise<RawFleetAuditReading> {
    let result: CaptureResult;
    try {
      result = await this.runCapturing(sshArgs(config.host, config.timeoutMs, ["ps", "-eo", "args="]), config.timeoutMs);
    } catch {
      return {
        outcome: "error",
        totalCandidates: null,
        flaggedCount: null,
        bareCount: null,
        note: "could not run the fleet-audit probe at all (e.g. ssh not on PATH)",
      };
    }
    if (result.timedOut) {
      return {
        outcome: "timeout",
        totalCandidates: null,
        flaggedCount: null,
        bareCount: null,
        note: "the fleet-audit probe did not complete within its configured timeout",
      };
    }
    if (result.exitCode !== 0) {
      // A nonzero exit here is an ssh/connection-level failure (auth, host
      // unreachable, etc.) — `ps` itself does not fail this way — so this
      // is "could not look," never a count of zero. Deliberately never
      // includes result.stdout — see this module's top comment, decision 4.
      return {
        outcome: "error",
        totalCandidates: null,
        flaggedCount: null,
        bareCount: null,
        note: `the fleet-audit ssh probe exited ${result.exitCode}`,
      };
    }
    const { totalCandidates, flaggedCount, bareCount } = classifyFleetProcesses(
      result.stdout,
      config.processMatch,
      config.expectedFlags,
    );
    return { outcome: "enumerated", totalCandidates, flaggedCount, bareCount, note: null };
  }
}
