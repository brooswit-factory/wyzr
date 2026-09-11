import { describe, expect, test } from "bun:test";
import { CliError, ExitCode } from "../../src/errors.ts";
import {
  defaultWedgeStatusDeps,
  runWedgeStatus,
  wedgeVerdictExitCode,
  formatWedgeStatusHuman,
  toWedgeStatusJson,
  type WedgeStatusDeps,
} from "../../src/cli-wedge.ts";
import { dispatchWedge } from "../../src/cli.ts";
import { WedgeVerdict, evaluateWedge } from "../../src/wedge.ts";
import { FakeWedgeProbes, fakeDirectPathDead, fakeLocalControlHealthy, fakeLocalControlUnhealthy } from "../../src/wedge-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY, type WedgeConfig } from "../../src/wedge-config.ts";
import { RealWedgeProbes } from "../../src/wedge-probes-real.ts";

const NOW = 1_800_000_000_000;

function provenConfig(): WedgeConfig {
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
    controlPlane: undefined,
  };
}

function deps(config: WedgeConfig, probes: FakeWedgeProbes): WedgeStatusDeps {
  return { loadConfig: () => config, createProbes: () => probes };
}

describe("wedgeVerdictExitCode — a distinct exit code per verdict class", () => {
  test("PROVEN maps to Ok (0)", () => {
    expect(wedgeVerdictExitCode(WedgeVerdict.Proven)).toBe(ExitCode.Ok);
  });
  test("NOT_PROVEN maps to its own dedicated code, distinct from Ok and from the inconclusive code", () => {
    expect(wedgeVerdictExitCode(WedgeVerdict.NotProven)).toBe(ExitCode.WedgeNotProven);
    expect(ExitCode.WedgeNotProven).not.toBe(ExitCode.Ok);
  });
  test("INCONCLUSIVE_BY_SHARED_CAUSE maps to yet another dedicated code — a script can tell it apart from NOT_PROVEN", () => {
    expect(wedgeVerdictExitCode(WedgeVerdict.InconclusiveBySharedCause)).toBe(ExitCode.WedgeInconclusiveBySharedCause);
    expect(ExitCode.WedgeInconclusiveBySharedCause).not.toBe(ExitCode.WedgeNotProven);
  });
});

describe("runWedgeStatus — never throws for a non-PROVEN verdict (OUTCOME codes, not error codes)", () => {
  test("PROVEN returns exit 0 and prints the payload, not an error envelope", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      sshHandler: async () => fakeDirectPathDead(),
      tunnelPingHandler: async () => fakeDirectPathDead(),
      localConnectivityHandler: async () => fakeLocalControlHealthy(),
    });
    const code = await runWedgeStatus(deps(provenConfig(), probes), true, NOW);
    expect(code).toBe(ExitCode.Ok);
  });

  test("NOT_PROVEN (a healthy box) returns exit 11, no throw", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 1000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 1000, note: null }),
    });
    const code = await runWedgeStatus(deps(provenConfig(), probes), false, NOW);
    expect(code).toBe(ExitCode.WedgeNotProven);
    expect(code).toBe(11);
  });

  test("INCONCLUSIVE_BY_SHARED_CAUSE returns exit 12, no throw", async () => {
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: NOW - 200_000, note: null }),
      // Explicitly dead, not the FakeWedgeProbes default of "alive" (WYZR-23:
      // an affirmatively alive direct path now outranks a failing control
      // and forces NOT_PROVEN — this test wants the OTHER case, where no
      // direct path answered, so the control failure alone is inconclusive.
      sshHandler: async () => fakeDirectPathDead(),
      tunnelPingHandler: async () => fakeDirectPathDead(),
      localConnectivityHandler: async () => fakeLocalControlUnhealthy(),
    });
    const code = await runWedgeStatus(deps(provenConfig(), probes), false, NOW);
    expect(code).toBe(ExitCode.WedgeInconclusiveBySharedCause);
    expect(code).toBe(12);
  });
});

describe("toWedgeStatusJson — the --json contract", () => {
  test("carries schemaVersion, command, verdict, and the full evidence trail — never a __brand field", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [],
    });
    const json = toWedgeStatusJson(result);
    expect(json.schemaVersion).toBe(1);
    expect(json.command).toBe("wedge status");
    expect(json.verdict).toBe(WedgeVerdict.NotProven);
    expect(JSON.stringify(json)).not.toContain("__brand");
  });

  test("lastSeenAt is rendered as an ISO 8601 string, not a bare epoch number", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [
        {
          __brand: "wedge-instrument",
          name: "jira",
          dependsOn: [],
          quietThresholdMs: 1000,
          outcome: "observed",
          lastSeenAt: NOW - 5000,
          note: null,
        },
      ],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [],
    });
    const json = toWedgeStatusJson(result);
    expect(json.instruments[0]!.lastSeenAt).toBe(new Date(NOW - 5000).toISOString());
  });

  test("a control-plane reading is allowlist-projected into the payload", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [{ __brand: "wedge-control-plane", name: "tailscale", online: true, note: null }],
    });
    const json = toWedgeStatusJson(result);
    expect(json.controlPlane).toEqual([{ name: "tailscale", online: true, note: null }]);
  });
});

describe("formatWedgeStatusHuman — the evidence trail is legible, not just a bare verdict", () => {
  test("includes the verdict, each instrument's quiet duration, direct-path results, and reasons", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [
        {
          __brand: "wedge-instrument",
          name: "jira-activity",
          dependsOn: ["manager-internet"],
          quietThresholdMs: 60_000,
          outcome: "observed",
          lastSeenAt: NOW - 200_000,
          note: null,
        },
      ],
      directPaths: [{ __brand: "wedge-direct-path", name: "ssh", outcome: "dead", note: null }],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: ["manager-internet"], note: null },
      controlPlane: [],
    });
    const text = formatWedgeStatusHuman(result);
    expect(text).toContain("Verdict: NOT_PROVEN");
    expect(text).toContain("jira-activity");
    expect(text).toContain("ssh: DEAD");
    expect(text).toContain("Reasons:");
  });

  test("an empty instruments/directPaths list renders '(none configured)', not a blank section", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [],
    });
    const text = formatWedgeStatusHuman(result);
    expect(text).toContain("Instruments:\n  (none configured)");
    expect(text).toContain("Direct paths:\n  (none configured)");
  });

  test("a degraded (non-observed) instrument is rendered distinctly from an active/silent one", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [
        { __brand: "wedge-instrument", name: "jira-activity", dependsOn: ["manager-internet"], quietThresholdMs: 1000, outcome: "unconfigured", lastSeenAt: null, note: "not configured" },
      ],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [],
    });
    const text = formatWedgeStatusHuman(result);
    expect(text).toContain("jira-activity: UNCONFIGURED (excluded from quorum)");
  });

  test("a non-empty control-plane reading is rendered in its own, clearly-informational section", () => {
    const result = evaluateWedge({
      now: NOW,
      instruments: [],
      directPaths: [],
      localControl: { __brand: "wedge-local-control", name: "local-connectivity", outcome: "healthy", confirms: [], note: null },
      controlPlane: [{ __brand: "wedge-control-plane", name: "tailscale", online: true, note: null }],
    });
    const text = formatWedgeStatusHuman(result);
    expect(text).toContain("Control-plane (informational only — cannot affect the verdict):");
    expect(text).toContain("tailscale: true");
  });
});

describe("dispatchWedge — routing", () => {
  test("`wedge status` runs the check", async () => {
    // dispatchWedge doesn't take an injected `now` (real CLI usage has none
    // to inject) — use the real clock here and report activity as "just
    // now" so the assertion (active, not silent) holds regardless of when
    // this test actually runs.
    const probes = new FakeWedgeProbes({
      jiraHandler: async () => ({ outcome: "observed", lastSeenAt: Date.now(), note: null }),
    });
    const code = await dispatchWedge(["status"], false, deps(provenConfig(), probes));
    expect(code).toBe(ExitCode.WedgeNotProven);
  });

  test("an unknown wedge subcommand is a usage error", async () => {
    await expect(dispatchWedge(["bogus"], false)).rejects.toThrow();
  });

  test("no subcommand at all is a usage error", async () => {
    await expect(dispatchWedge([], false)).rejects.toThrow();
  });
});

describe("defaultWedgeStatusDeps — the real (production) wiring, exercised only for construction, never invoked", () => {
  test("createProbes() constructs a RealWedgeProbes", () => {
    expect(defaultWedgeStatusDeps.createProbes()).toBeInstanceOf(RealWedgeProbes);
  });

  // WYZR-20/WYZR-28: loadConfig() now reads a REAL config.json from disk
  // (src/config.ts's loadWyzrConfig()) via purely local filesystem I/O
  // (zero network, zero credentials) — same category of "real, local-only
  // call" this repo already exercises directly elsewhere (e.g.
  // test/unit/cycle-wrong-box.test.ts's "the real (uninjected) probe
  // actually enumerates this process's own network addresses" tests). This
  // machine may or may not have a real config.json, so both outcomes are
  // accepted: either a real WedgeConfig comes back, or the loader refuses
  // with its own ConfigInvalid exit code — anything else is a bug this test
  // would catch. The loader's own full refusal/shape behavior is covered
  // exhaustively by test/unit/config.test.ts against fixture files.
  test("loadConfig() either returns a real WedgeConfig or refuses with ConfigInvalid — never anything else", () => {
    try {
      const config = defaultWedgeStatusDeps.loadConfig();
      expect(config.localConnectivity).toBeDefined();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(ExitCode.ConfigInvalid);
    }
  });
});
