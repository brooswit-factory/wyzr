import { describe, expect, test } from "bun:test";
import {
  classifyDaemonOutput,
  classifyFleetProcesses,
  parseUptimeSeconds,
  RealRecoveryProbes,
} from "../../src/recovery-probes-real.ts";
import type { CaptureResult } from "../../src/wedge-probes-real.ts";
import type { DaemonProbeConfig, FleetAuditConfig, UptimeProbeConfig } from "../../src/recovery-probes.ts";

describe("parseUptimeSeconds — the pure /proc/uptime parser", () => {
  test("a well-formed reading: parses the first field", () => {
    expect(parseUptimeSeconds("12345.67 98765.43\n")).toBe(12345.67);
  });

  test("zero uptime (just booted) is valid, not treated as missing", () => {
    expect(parseUptimeSeconds("0.00 0.00\n")).toBe(0);
  });

  test("empty output: unparseable", () => {
    expect(parseUptimeSeconds("")).toBeNull();
  });

  test("non-numeric output: unparseable — never a pass, never a fail, just unparseable", () => {
    expect(parseUptimeSeconds("not a number at all")).toBeNull();
  });

  test("a negative number: rejected (uptime cannot be negative — a malformed reading, not a real one)", () => {
    expect(parseUptimeSeconds("-5.0 10.0")).toBeNull();
  });
});

describe("classifyDaemonOutput — the pure systemctl-show classifier (named test 7's raw half)", () => {
  test("LoadState=loaded, ActiveState=active: healthy", () => {
    expect(classifyDaemonOutput("LoadState=loaded\nActiveState=active\n").outcome).toBe("healthy");
  });

  test("LoadState=loaded, ActiveState=inactive: unhealthy — never confused with pointed-at-nothing", () => {
    const result = classifyDaemonOutput("LoadState=loaded\nActiveState=inactive\n");
    expect(result.outcome).toBe("unhealthy");
  });

  test("LoadState=loaded, ActiveState=failed: unhealthy", () => {
    expect(classifyDaemonOutput("LoadState=loaded\nActiveState=failed\n").outcome).toBe("unhealthy");
  });

  test('LoadState=not-found: pointed-at-nothing — the wrong-scope shape, never read as "unhealthy"', () => {
    const result = classifyDaemonOutput("LoadState=not-found\nActiveState=inactive\n");
    expect(result.outcome).toBe("pointed-at-nothing");
    expect(result.outcome).not.toBe("unhealthy");
  });

  test("output missing the expected properties entirely: error (could not look), never a guess", () => {
    expect(classifyDaemonOutput("something unexpected\n").outcome).toBe("error");
  });

  test("extra whitespace/blank lines around the properties are tolerated", () => {
    expect(classifyDaemonOutput("\nLoadState=loaded\n\nActiveState=active\n\n").outcome).toBe("healthy");
  });
});

describe("classifyFleetProcesses — the pure candidate-classifier (the enumeration trap)", () => {
  test("the candidate set is built from processMatch, never from expectedFlags — a bare pane still counts", () => {
    // This is the exact trap relayed on the ticket: a bare-restored pane's
    // argv carries NONE of the expected flags. If the candidate set were
    // built by filtering on expectedFlags, this bare process would be
    // excluded from the denominator entirely (the "N of N healthy, on a
    // fleet that is half bare" failure). Building the set from
    // `processMatch` (the binary name — something every candidate, bare or
    // not, still has) is what catches it.
    const ps = ["claude --resume abc123session", "claude --mcp-config /workspace/mcp.json --permission-mode bypassPermissions"].join(
      "\n",
    );
    const result = classifyFleetProcesses(ps, "claude", ["--mcp-config"]);
    expect(result.totalCandidates).toBe(2);
    expect(result.flaggedCount).toBe(1);
    expect(result.bareCount).toBe(1);
  });

  test("a process must carry EVERY expected flag to count as flagged, not merely one of them", () => {
    const ps = "claude --mcp-config /workspace/mcp.json"; // missing --permission-mode
    const result = classifyFleetProcesses(ps, "claude", ["--mcp-config", "--permission-mode"]);
    expect(result.totalCandidates).toBe(1);
    expect(result.flaggedCount).toBe(0);
    expect(result.bareCount).toBe(1);
  });

  test("non-matching processes never enter the candidate set at all", () => {
    const ps = ["sshd: user@pts/0", "bash", "claude --mcp-config x --permission-mode y"].join("\n");
    const result = classifyFleetProcesses(ps, "claude", ["--mcp-config", "--permission-mode"]);
    expect(result.totalCandidates).toBe(1);
    expect(result.bareCount).toBe(0);
  });

  test("zero candidates: totalCandidates 0, never an error", () => {
    const result = classifyFleetProcesses("sshd: user@pts/0\nbash\n", "claude", ["--mcp-config"]);
    expect(result.totalCandidates).toBe(0);
    expect(result.flaggedCount).toBe(0);
    expect(result.bareCount).toBe(0);
  });

  test("blank lines are ignored, never counted as candidates", () => {
    const result = classifyFleetProcesses("\n\nclaude --mcp-config x\n\n\n", "claude", ["--mcp-config"]);
    expect(result.totalCandidates).toBe(1);
  });

  test(
    "named test 15: a fixture whose raw text contains a session-id-shaped string — that string appears " +
      "nowhere in the returned object, in either JSON or plain-text form",
    () => {
      const sessionIdShaped = "01EAhdL37nbd6ycf68Pksoqx-session-secret-shaped-value";
      const ps = [
        `claude --resume ${sessionIdShaped}`,
        `claude --mcp-config /workspace/mcp.json --session-id ${sessionIdShaped}`,
      ].join("\n");
      const result = classifyFleetProcesses(ps, "claude", ["--mcp-config"]);

      // The return type itself is COUNTS ONLY (totalCandidates/flaggedCount/
      // bareCount, all numbers) — there is no field a string could even be
      // assigned to. This assertion is the belt to that type-level braces:
      // stringify the WHOLE result and assert the raw fixture text is
      // nowhere in it, on either side of the flagged/bare split.
      const serialized = JSON.stringify(result);
      expect(serialized.includes(sessionIdShaped)).toBe(false);
      expect(result.totalCandidates).toBe(2);
      expect(result.bareCount).toBe(1);
    },
  );
});

const UPTIME_CONFIG: UptimeProbeConfig = { host: "example-not-real.invalid", timeoutMs: 5000 };
const DAEMON_CONFIG: DaemonProbeConfig = { host: "example-not-real.invalid", unit: "example.service", scope: "user", timeoutMs: 5000 };
const FLEET_CONFIG: FleetAuditConfig = {
  host: "example-not-real.invalid",
  processMatch: "claude",
  expectedFlags: ["--mcp-config"],
  timeoutMs: 5000,
};

describe("RealRecoveryProbes.checkUptime", () => {
  test("a well-formed /proc/uptime reply: observed, converted to milliseconds", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "123.45 67.89\n", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("observed");
    expect(reading.uptimeMs).toBe(123450);
  });

  test("unparseable output: error, never a pass or a fail, never a wall-clock fallback", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "garbage\n", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("error");
    expect(reading.uptimeMs).toBeNull();
  });

  test("nonzero exit (ssh-level failure): error", async () => {
    const capture: CaptureResult = { exitCode: 255, stdout: "", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("error");
  });

  test("timeout: timeout", async () => {
    const capture: CaptureResult = { exitCode: null, stdout: "", timedOut: true };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("timeout");
  });

  test("ssh not on PATH (a throw): error, never a thrown exception escaping this method", async () => {
    const probes = new RealRecoveryProbes({
      runCapturing: async () => {
        throw new Error("spawn ssh ENOENT");
      },
    });
    const reading = await probes.checkUptime(UPTIME_CONFIG);
    expect(reading.outcome).toBe("error");
  });
});

describe("RealRecoveryProbes.checkDaemon", () => {
  test("healthy unit: healthy", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "LoadState=loaded\nActiveState=active\n", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkDaemon(DAEMON_CONFIG);
    expect(reading.outcome).toBe("healthy");
  });

  test("wrong scope (not-found): pointed-at-nothing", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkDaemon(DAEMON_CONFIG);
    expect(reading.outcome).toBe("pointed-at-nothing");
  });

  test("the --user flag is included only for scope 'user'", async () => {
    let seenCmd: readonly string[] = [];
    const probes = new RealRecoveryProbes({
      runCapturing: async (cmd) => {
        seenCmd = cmd;
        return { exitCode: 0, stdout: "LoadState=loaded\nActiveState=active\n", timedOut: false };
      },
    });
    await probes.checkDaemon({ ...DAEMON_CONFIG, scope: "user" });
    expect(seenCmd.includes("--user")).toBe(true);

    await probes.checkDaemon({ ...DAEMON_CONFIG, scope: "system" });
    expect(seenCmd.includes("--user")).toBe(false);
  });

  test("timeout: timeout", async () => {
    const capture: CaptureResult = { exitCode: null, stdout: "", timedOut: true };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkDaemon(DAEMON_CONFIG);
    expect(reading.outcome).toBe("timeout");
  });
});

describe("RealRecoveryProbes.checkFleetAudit", () => {
  test("a well-formed process list: enumerated, with counts", async () => {
    const capture: CaptureResult = {
      exitCode: 0,
      stdout: "claude --mcp-config x\nclaude --resume abc\n",
      timedOut: false,
    };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.outcome).toBe("enumerated");
    expect(reading.totalCandidates).toBe(2);
    expect(reading.flaggedCount).toBe(1);
    expect(reading.bareCount).toBe(1);
  });

  test(
    "named test 15 (probe-level): a session-id-shaped string in the raw ps output never reaches the " +
      "reading — on the success path",
    async () => {
      const sessionIdShaped = "session-01EAhdL37nbd6ycf68Pksoqx-shaped";
      const capture: CaptureResult = { exitCode: 0, stdout: `claude --resume ${sessionIdShaped}\n`, timedOut: false };
      const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
      const reading = await probes.checkFleetAudit(FLEET_CONFIG);
      expect(JSON.stringify(reading).includes(sessionIdShaped)).toBe(false);
    },
  );

  test(
    "named test 15 (probe-level): a session-id-shaped string never reaches the reading on the ERROR path " +
      "either — the ssh-nonzero-exit branch never touches stdout at all",
    async () => {
      const sessionIdShaped = "session-01EAhdL37nbd6ycf68Pksoqx-shaped";
      const capture: CaptureResult = { exitCode: 255, stdout: `claude --resume ${sessionIdShaped}\n`, timedOut: false };
      const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
      const reading = await probes.checkFleetAudit(FLEET_CONFIG);
      expect(reading.outcome).toBe("error");
      expect(JSON.stringify(reading).includes(sessionIdShaped)).toBe(false);
    },
  );

  test("zero candidates: enumerated with totalCandidates 0, never an error", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "sshd: user\nbash\n", timedOut: false };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.outcome).toBe("enumerated");
    expect(reading.totalCandidates).toBe(0);
  });

  test("timeout: timeout, counts null", async () => {
    const capture: CaptureResult = { exitCode: null, stdout: "", timedOut: true };
    const probes = new RealRecoveryProbes({ runCapturing: async () => capture });
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.outcome).toBe("timeout");
    expect(reading.totalCandidates).toBeNull();
  });

  test("ssh not on PATH (a throw): error, never a thrown exception escaping this method", async () => {
    const probes = new RealRecoveryProbes({
      runCapturing: async () => {
        throw new Error("spawn ssh ENOENT");
      },
    });
    const reading = await probes.checkFleetAudit(FLEET_CONFIG);
    expect(reading.outcome).toBe("error");
  });
});

describe("RealRecoveryProbes — constructed with no options at all uses the real defaults (no method is called, so this touches no network/subprocess)", () => {
  test("plain construction succeeds", () => {
    expect(() => new RealRecoveryProbes()).not.toThrow();
  });
});
