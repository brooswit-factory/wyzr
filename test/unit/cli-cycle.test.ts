// End-to-end tests for `wyzr cycle`'s wiring (src/cli-cycle.ts) against
// FakeWyzeTransport and fixture credentials — zero credentials file, zero
// network, zero real writes. Focuses on the parts src/cycle-runner.test.ts
// does not cover: CLI argument parsing and the D4 force ceremony (the long
// flag, printing the full preview before acting, the interactive/
// non-interactive confirmation — including named test 6, "force flag
// WITHOUT its confirmation -> refuses").

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  FORCE_FLAG,
  NON_INTERACTIVE_CONFIRM_PREFIX,
  defaultCycleCommandDeps,
  parseCycleArgs,
  realConfirm,
  runCycleCommand,
  type CycleCommandDeps,
} from "../../src/cli-cycle.ts";
import type { Credentials } from "../../src/credentials.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { resetSecretsForTesting } from "../../src/redact.ts";
import {
  FAKE_PLUG_ONLINE,
  FakeWyzeTransport,
  fakeGetObjectListEnvelope,
  fakePropertyListEnvelope,
  fakeSetPropertyEnvelope,
} from "../../src/transport-fake.ts";
import { RealWyzeTransport } from "../../src/transport-http.ts";
import { RealWedgeProbes } from "../../src/wedge-probes-real.ts";
import { RealRecoveryProbes } from "../../src/recovery-probes-real.ts";
import { RealLocalIdentityProbe } from "../../src/cycle-wrong-box.ts";
import { FakeWedgeProbes, fakeDirectPathDead, fakeLocalControlHealthy } from "../../src/wedge-probes-fake.ts";
import { FakeRecoveryProbes } from "../../src/recovery-probes-fake.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_CONFIG, MANAGER_INTERNET_DEPENDENCY } from "../../src/wedge-config.ts";
import { createFakeCycleClock, RealCycleClock } from "../../src/cycle-clock.ts";
import type { CycleConfig } from "../../src/cycle-config.ts";

afterEach(() => {
  resetSecretsForTesting();
});

const FAKE_CREDS: Credentials = {
  email: "test-account@example.invalid",
  password: "fake-test-password-000",
  keyId: "fake-key-id-000",
  keySecret: "fake-key-secret-000",
  totpSecret: undefined,
};

const TARGET_HOST_FIXTURE = "cli-cycle-target-fixture.invalid";
const NOT_TARGET_HOST_FIXTURE = "cli-cycle-runner-fixture.invalid";

function silence(): { restore: () => void } {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  return { restore: () => logSpy.mockRestore() };
}

function fixtureConfig(overrides: Partial<CycleConfig> = {}): CycleConfig {
  return {
    gate: {
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
      controlPlane: undefined,
    },
    recovery: {
      jira: undefined,
      github: undefined,
      ssh: undefined,
      tunnelPing: undefined,
      localConnectivity: DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
      uptime: undefined,
      daemon: undefined,
      fleet: undefined,
    },
    wrongBoxTargetHost: TARGET_HOST_FIXTURE,
    handRestoreCommand: "cli-cycle-fixture-restore-command --now",
    timing: {
      offToOnWaitMs: 5,
      offReadbackPollIntervalMs: 5,
      offReadbackBoundMs: 20,
      restoreReadbackPollIntervalMs: 5,
      restoreReadbackBoundMs: 20,
      restorePollIntervalMs: 5,
      restoreTimeoutMs: 60,
    },
    ...overrides,
  };
}

function baseDeps(overrides: Partial<CycleCommandDeps> = {}): CycleCommandDeps {
  return {
    loadCredentials: async () => FAKE_CREDS,
    createTransport: () =>
      new FakeWyzeTransport({
        getObjectListHandler: () =>
          fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: "FAKE0000MAC0", nickname: "Test Plug" }]),
        getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 1, P5: 1 }),
        setPropertyHandler: () => fakeSetPropertyEnvelope(),
      }),
    loadConfig: () => fixtureConfig(),
    createGateProbes: () => new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() }),
    createRecoveryWedgeProbes: () => new FakeWedgeProbes({ localConnectivityHandler: async () => fakeLocalControlHealthy() }),
    createRecoveryProbes: () => new FakeRecoveryProbes(),
    createIdentityProbe: () => ({ getLocalHostname: async () => NOT_TARGET_HOST_FIXTURE }),
    clock: createFakeCycleClock(1_800_000_000_000),
    confirm: async () => null,
    ...overrides,
  };
}

describe("parseCycleArgs", () => {
  test("a bare device name with no flags", () => {
    const { device, options } = parseCycleArgs(["Garage Plug"]);
    expect(device).toBe("Garage Plug");
    expect(options.dryRun).toBe(false);
    expect(options.force).toBe(false);
    expect(options.nonInteractiveConfirmTarget).toBeUndefined();
  });

  test("--dry-run, the force flag, and the non-interactive confirm target are all recognised and stripped from the positional args", () => {
    const { device, options } = parseCycleArgs([
      "Garage Plug",
      "--dry-run",
      FORCE_FLAG,
      `${NON_INTERACTIVE_CONFIRM_PREFIX}my-target-fixture`,
    ]);
    expect(device).toBe("Garage Plug");
    expect(options.dryRun).toBe(true);
    expect(options.force).toBe(true);
    expect(options.nonInteractiveConfirmTarget).toBe("my-target-fixture");
  });

  test("no positional device argument -> device is undefined", () => {
    const { device } = parseCycleArgs(["--dry-run"]);
    expect(device).toBeUndefined();
  });
});

describe("runCycleCommand — ordinary (non-forced) path", () => {
  test("an unconfigured gate (NOT_PROVEN) refuses, exit code CycleRefusedByGate", async () => {
    const ui = silence();
    const code = await runCycleCommand(baseDeps(), "Test Plug", false, {
      dryRun: false,
      force: false,
      nonInteractiveConfirmTarget: undefined,
    });
    expect(code).toBe(ExitCode.CycleRefusedByGate);
    ui.restore();
  });

  test("--dry-run on the same unconfigured gate also refuses, same code, and prints a human-readable payload", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const code = await runCycleCommand(baseDeps(), "Test Plug", false, {
      dryRun: true,
      force: false,
      nonInteractiveConfirmTarget: undefined,
    });
    expect(code).toBe(ExitCode.CycleRefusedByGate);
    expect(logSpy.mock.calls.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  test("device resolution failure (no matching device) surfaces as the existing NotFound CliError, not a cycle outcome", async () => {
    const ui = silence();
    await expect(
      runCycleCommand(baseDeps(), "Nonexistent Device", false, { dryRun: true, force: false, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(CliError);
    ui.restore();
  });
});

describe("runCycleCommand — named test 6: force flag WITHOUT its confirmation -> refuses", () => {
  test("--force with no confirmation available (confirm() returns null, i.e. not a TTY) and no non-interactive flag -> Usage error, the force flag alone was not sufficient", async () => {
    const ui = silence();
    const deps = baseDeps({ confirm: async () => null });
    await expect(
      runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(/requires typing the exact configured target host name|neither was satisfied/);
    ui.restore();
  });

  test("--force with an interactive confirmation that does NOT match the target -> Usage error, refuses", async () => {
    const ui = silence();
    const deps = baseDeps({ confirm: async () => "the-wrong-answer" });
    await expect(
      runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(CliError);
    ui.restore();
  });

  test("--force-non-interactive-confirm-target with a value that does not match the configured target -> Usage error, refuses", async () => {
    const ui = silence();
    const deps = baseDeps();
    await expect(
      runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: "wrong-target" }),
    ).rejects.toThrow(/did not match the configured target/);
    ui.restore();
  });

  test("--force with no configured wrong-box target at all -> Usage error before any confirmation is even attempted", async () => {
    const ui = silence();
    const deps = baseDeps({ loadConfig: () => fixtureConfig({ wrongBoxTargetHost: undefined }) });
    await expect(
      runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(/requires WYZR_CYCLE_WRONG_BOX_TARGET_HOST to be configured/);
    ui.restore();
  });
});

describe("runCycleCommand — force WITH a satisfied confirmation proceeds to the real run", () => {
  test("--force-non-interactive-confirm-target matching the configured target exactly -> forced=true reaches the real (unconfigured-gate) refusal, not the force-ceremony Usage error", async () => {
    const ui = silence();
    const code = await runCycleCommand(baseDeps(), "Test Plug", false, {
      dryRun: true,
      force: true,
      nonInteractiveConfirmTarget: TARGET_HOST_FIXTURE,
    });
    // Gate is unconfigured (NOT_PROVEN) in this fixture, but the wrong-box
    // guard and preconditions both clear — so a satisfied force ceremony
    // reaches runCycleDryRun() with forced=true, which (per D4) proceeds
    // past the gate straight to "would_act".
    expect(code).toBe(ExitCode.CycleDryRunWouldAct);
    ui.restore();
  });

  test("the interactive confirm() function is called with the configured target host, naming it (D4: confirmation NAMING THE TARGET)", async () => {
    const ui = silence();
    let seenTarget: string | undefined;
    const deps = baseDeps({
      confirm: async (target) => {
        seenTarget = target;
        return target;
      },
    });
    await runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: undefined });
    expect(seenTarget).toBe(TARGET_HOST_FIXTURE);
    ui.restore();
  });

  test("--json mode prints the force preview as JSON too, not just human text", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const deps = baseDeps();
    const code = await runCycleCommand(deps, "Test Plug", true, {
      dryRun: true,
      force: true,
      nonInteractiveConfirmTarget: TARGET_HOST_FIXTURE,
    });
    expect(code).toBe(ExitCode.CycleDryRunWouldAct);
    const printedPreview = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printedPreview.command).toBe("cycle");
    logSpy.mockRestore();
  });

  test("the full unforced preview is printed BEFORE the confirmation is requested (D4: evidence trail printed before acting)", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let confirmCalledAfterPreviewPrinted = false;
    const deps = baseDeps({
      confirm: async (target) => {
        confirmCalledAfterPreviewPrinted = logSpy.mock.calls.length > 0;
        return target;
      },
    });
    await runCycleCommand(deps, "Test Plug", false, { dryRun: true, force: true, nonInteractiveConfirmTarget: undefined });
    expect(confirmCalledAfterPreviewPrinted).toBe(true);
    logSpy.mockRestore();
  });
});

describe("runCycleCommand — a full LIVE cycle end-to-end (PROVEN gate, real OFF/ON writes through RealCyclePlugTransport)", () => {
  test("gate PROVEN, preconditions clear, OFF and ON both actually write and read back through the real plug-control boundary, recovery composes to UNCONFIGURED (nothing configured for it in this fixture)", async () => {
    const ui = silence();
    // A minimal simulated plug: writePower actually changes what the next
    // readState() call observes, through the REAL RealCyclePlugTransport
    // (not a hand-rolled fake) — this is what exercises
    // src/cycle-plug.ts's writePower() for real, via the same
    // FakeWyzeTransport/envelope-decode path devices/plug commands use.
    let currentP3 = "1";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () =>
        fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: "FAKE0000MAC0", nickname: "Test Plug" }]),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: currentP3, P5: 1 }),
      setPropertyHandler: (req) => {
        currentP3 = req.value;
        return fakeSetPropertyEnvelope();
      },
    });

    const gateConfig: CycleConfig["gate"] = {
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
      controlPlane: undefined,
    };

    const deps = baseDeps({
      createTransport: () => transport,
      loadConfig: () => fixtureConfig({ gate: gateConfig }),
      createGateProbes: () =>
        new FakeWedgeProbes({
          jiraHandler: async () => ({ outcome: "observed", lastSeenAt: 0, note: null }),
          gitHubHandler: async () => ({ outcome: "observed", lastSeenAt: 0, note: null }),
          sshHandler: async () => fakeDirectPathDead(),
          tunnelPingHandler: async () => fakeDirectPathDead(),
          localConnectivityHandler: async () => fakeLocalControlHealthy(),
        }),
      clock: createFakeCycleClock(200_000_000), // far past any quiet threshold measured from epoch 0
    });

    const code = await runCycleCommand(deps, "Test Plug", false, {
      dryRun: false,
      force: false,
      nonInteractiveConfirmTarget: undefined,
    });

    // Nothing configured for the post-cycle recovery check in this
    // fixture -> UNCONFIGURED, its own distinct code — but getting THERE
    // at all proves the OFF write, the wait, and the ON never-give-up
    // restore all actually ran through the real plug-control boundary.
    expect(code).toBe(ExitCode.CycleRecoveryUnconfigured);
    expect(currentP3).toBe("1"); // ended up back ON
    ui.restore();
  });
});

describe("defaultCycleCommandDeps — real wiring constructors (construction only, no network)", () => {
  test("createTransport() constructs a RealWyzeTransport", () => {
    expect(defaultCycleCommandDeps.createTransport()).toBeInstanceOf(RealWyzeTransport);
  });
  test("createGateProbes()/createRecoveryWedgeProbes() construct RealWedgeProbes", () => {
    expect(defaultCycleCommandDeps.createGateProbes()).toBeInstanceOf(RealWedgeProbes);
    expect(defaultCycleCommandDeps.createRecoveryWedgeProbes()).toBeInstanceOf(RealWedgeProbes);
  });
  test("createRecoveryProbes() constructs a RealRecoveryProbes", () => {
    expect(defaultCycleCommandDeps.createRecoveryProbes()).toBeInstanceOf(RealRecoveryProbes);
  });
  test("createIdentityProbe() constructs a RealLocalIdentityProbe", () => {
    expect(defaultCycleCommandDeps.createIdentityProbe()).toBeInstanceOf(RealLocalIdentityProbe);
  });
  test("clock is RealCycleClock, and loadConfig() reads real env without touching the network", () => {
    expect(defaultCycleCommandDeps.clock).toBe(RealCycleClock);
    expect(defaultCycleCommandDeps.loadConfig().wrongBoxTargetHost).toBeUndefined();
  });
});

describe("realConfirm — the real (non-TTY) path", () => {
  test("returns null immediately when this process is not a TTY (the normal case for a test runner and for any non-interactive invocation)", async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    const result = await realConfirm("some-target-fixture");
    expect(result).toBeNull();
  });
});

describe("realConfirm — the TTY path (stdin mocked, never a real terminal)", () => {
  test("prints the prompt naming the target, then resolves with the typed line, trimmed", async () => {
    const stdin = process.stdin as unknown as {
      isTTY: boolean | undefined;
      resume: () => unknown;
      pause: () => unknown;
      on: (event: string, listener: (chunk: Buffer) => void) => unknown;
      off: (event: string, listener: (chunk: Buffer) => void) => unknown;
    };
    const originalIsTTY = stdin.isTTY;
    stdin.isTTY = true;

    const resumeSpy = spyOn(stdin, "resume").mockImplementation(() => stdin);
    const pauseSpy = spyOn(stdin, "pause").mockImplementation(() => stdin);
    const offSpy = spyOn(stdin, "off").mockImplementation(() => stdin);
    const onSpy = spyOn(stdin, "on").mockImplementation((event, listener) => {
      if (event === "data") {
        queueMicrotask(() => listener(Buffer.from("  typed-target-fixture  \n")));
      }
      return stdin;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const result = await realConfirm("typed-target-fixture");

    expect(result).toBe("typed-target-fixture");
    expect(logSpy.mock.calls[0]?.[0]).toContain("typed-target-fixture");
    expect(resumeSpy).toHaveBeenCalled();
    expect(offSpy).toHaveBeenCalled();
    expect(pauseSpy).toHaveBeenCalled();

    stdin.isTTY = originalIsTTY;
    resumeSpy.mockRestore();
    pauseSpy.mockRestore();
    offSpy.mockRestore();
    onSpy.mockRestore();
    logSpy.mockRestore();
  });
});
