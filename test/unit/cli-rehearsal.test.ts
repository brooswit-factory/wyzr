// End-to-end tests for `wyzr rehearse-safe-plug-write`'s wiring
// (src/cli-rehearsal.ts) against FakeWyzeTransport, fixture credentials, and
// a REAL `loadWyzrConfig()` call against a temp-directory fixture (same
// branding-forces-the-real-loader technique test/unit/rehearsal-runner.test.ts
// and test/unit/doctor-runner.test.ts already use) — zero credentials file
// on the real filesystem, zero network, zero real writes.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRM_WRITE_FLAG,
  NON_INTERACTIVE_CONFIRM_PREFIX,
  defaultRehearsalCommandDeps,
  parseRehearsalArgs,
  realConfirm,
  runRehearsalCommand,
  type RehearsalCommandDeps,
} from "../../src/cli-rehearsal.ts";
import { dispatchRehearsal } from "../../src/cli.ts";
import { loadWyzrConfig, type WyzrConfig, type WyzrConfigEnv } from "../../src/config.ts";
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
import { RealCycleClock, createFakeCycleClock } from "../../src/cycle-clock.ts";

afterEach(() => {
  resetSecretsForTesting();
});

const FAKE_CREDS: Credentials = {
  email: "cli-rehearsal-fixture@example.invalid",
  password: "fake-test-password-000",
  keyId: "fake-key-id-000",
  keySecret: "fake-key-secret-000",
  totpSecret: undefined,
};

const FLEET_MAC = "AA:BB:CC:DD:EE:01";
const SAFE_MAC = "11:22:33:44:55:02";
const SAFE_NAME = "fixture-safe-plug";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Mints a REAL, properly-branded WyzrConfig via a temp-file fixture and
 * the actual loader — see this file's own top comment. */
async function buildConfig(): Promise<WyzrConfig> {
  const base = await mkdtemp(join(tmpdir(), "wyzr-cli-rehearsal-test-"));
  tempDirs.push(base);
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const path = join(dir, "config.json");
  const content = {
    suspectBox: { host: "cli-rehearsal-fixture-suspect-box.invalid" },
    fleetPlug: { mac: FLEET_MAC, model: "WLPP1CFH", name: "fixture-fleet-plug" },
    safePlug: { mac: SAFE_MAC, model: "WLPPO", name: SAFE_NAME, subDeviceId: `${SAFE_MAC}-SUB1` },
    cycle: {
      timing: {
        offToOnWaitMs: 5,
        offReadbackPollIntervalMs: 5,
        offReadbackBoundMs: 20,
        restoreReadbackPollIntervalMs: 5,
        restoreReadbackBoundMs: 20,
        restorePollIntervalMs: 5,
        restoreTimeoutMs: 60,
      },
    },
  };
  await writeFile(path, JSON.stringify(content), "utf8");
  await chmod(path, 0o600);
  const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };
  return loadWyzrConfig(env);
}

function silence(): { restore: () => void } {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  return { restore: () => logSpy.mockRestore() };
}

async function baseDeps(overrides: Partial<RehearsalCommandDeps> = {}): Promise<RehearsalCommandDeps> {
  const config = await buildConfig();
  return {
    loadCredentials: async () => FAKE_CREDS,
    createTransport: () =>
      new FakeWyzeTransport({
        getObjectListHandler: () => fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, nickname: SAFE_NAME }]),
        getPropertyListHandler: () => fakePropertyListEnvelope({ P3: 1, P5: 1 }),
        setPropertyHandler: () => fakeSetPropertyEnvelope(),
      }),
    loadConfig: () => config,
    clock: createFakeCycleClock(1_800_000_000_000),
    confirm: async () => null,
    sameDeviceCheck: () => false,
    ...overrides,
  };
}

describe("parseRehearsalArgs", () => {
  test("no flags at all", () => {
    const options = parseRehearsalArgs([]);
    expect(options.dryRun).toBe(false);
    expect(options.confirmWrite).toBe(false);
    expect(options.nonInteractiveConfirmTarget).toBeUndefined();
  });

  test("--dry-run, the confirm flag, and the non-interactive confirm target are all recognised", () => {
    const options = parseRehearsalArgs(["--dry-run", CONFIRM_WRITE_FLAG, `${NON_INTERACTIVE_CONFIRM_PREFIX}my-plug-fixture`]);
    expect(options.dryRun).toBe(true);
    expect(options.confirmWrite).toBe(true);
    expect(options.nonInteractiveConfirmTarget).toBe("my-plug-fixture");
  });

  test("NO positional argument is ever accepted — property 1's 'not reachable by a CLI positional argument', enforced literally: any extra token is a Usage error", () => {
    expect(() => parseRehearsalArgs(["some-device-name"])).toThrow(CliError);
    expect(() => parseRehearsalArgs(["some-device-name"])).toThrow(/takes NO device argument/);
  });

  test("an unrecognized flag is also a Usage error, not silently ignored", () => {
    expect(() => parseRehearsalArgs(["--bogus-flag"])).toThrow(CliError);
  });
});

describe("runRehearsalCommand — property 4: never by default", () => {
  test("no flags at all -> preview only, never writes (exit code is the preview code, not confirmed/0)", async () => {
    const ui = silence();
    const deps = await baseDeps();
    const code = await runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: false, nonInteractiveConfirmTarget: undefined });
    expect(code).toBe(ExitCode.RehearsalPreviewWouldWrite);
    ui.restore();
  });

  test("--dry-run explicitly -> same preview-only behavior", async () => {
    const ui = silence();
    const deps = await baseDeps();
    const code = await runRehearsalCommand(deps, false, { dryRun: true, confirmWrite: false, nonInteractiveConfirmTarget: undefined });
    expect(code).toBe(ExitCode.RehearsalPreviewWouldWrite);
    ui.restore();
  });

  test("--dry-run combined with the confirm flag -> Usage error, refuses before doing anything", async () => {
    const ui = silence();
    const deps = await baseDeps();
    await expect(
      runRehearsalCommand(deps, false, { dryRun: true, confirmWrite: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(/cannot be combined/);
    ui.restore();
  });
});

describe("runRehearsalCommand — the confirmation ceremony", () => {
  test("confirm flag WITHOUT its confirmation (confirm() returns null, i.e. not a TTY) and no non-interactive flag -> Usage error, the confirm flag alone was not sufficient", async () => {
    const ui = silence();
    const deps = await baseDeps({ confirm: async () => null });
    await expect(
      runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(/requires typing the exact configured safe plug's name|neither was satisfied/);
    ui.restore();
  });

  test("an interactive confirmation that does NOT match the safe plug's name -> Usage error, refuses", async () => {
    const ui = silence();
    const deps = await baseDeps({ confirm: async () => "the-wrong-answer" });
    await expect(
      runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: true, nonInteractiveConfirmTarget: undefined }),
    ).rejects.toThrow(CliError);
    ui.restore();
  });

  test("--non-interactive-confirm-target with a value that does not match the configured safe plug's name -> Usage error, refuses", async () => {
    const ui = silence();
    const deps = await baseDeps();
    await expect(
      runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: true, nonInteractiveConfirmTarget: "wrong-name" }),
    ).rejects.toThrow(/did not match the configured safe plug's name/);
    ui.restore();
  });

  test("the interactive confirm() function is called with the configured safe plug's NAME, naming it", async () => {
    const ui = silence();
    let seenName: string | undefined;
    const deps = await baseDeps({
      confirm: async (name) => {
        seenName = name;
        return name;
      },
    });
    await runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: true, nonInteractiveConfirmTarget: undefined });
    expect(seenName).toBe(SAFE_NAME);
    ui.restore();
  });

  test("the full preview is printed BEFORE the confirmation is requested", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let confirmCalledAfterPreviewPrinted = false;
    const deps = await baseDeps({
      confirm: async (name) => {
        confirmCalledAfterPreviewPrinted = logSpy.mock.calls.length > 0;
        return name;
      },
    });
    await runRehearsalCommand(deps, false, { dryRun: false, confirmWrite: true, nonInteractiveConfirmTarget: undefined });
    expect(confirmCalledAfterPreviewPrinted).toBe(true);
    logSpy.mockRestore();
  });

  test("--non-interactive-confirm-target matching the configured safe plug's name exactly -> proceeds to the real (live) run", async () => {
    const ui = silence();
    const deps = await baseDeps();
    const code = await runRehearsalCommand(deps, false, {
      dryRun: false,
      confirmWrite: true,
      nonInteractiveConfirmTarget: SAFE_NAME,
    });
    // Preconditions clear (P3=1/P5=1 from the fixture transport) and the
    // guard-2 fake always returns false -> reaches a real OFF/restore
    // cycle -> confirmed, exit 0.
    expect(code).toBe(ExitCode.Ok);
    ui.restore();
  });
});

describe("runRehearsalCommand — a full LIVE rehearsal end-to-end (real OFF/ON writes through RealCyclePlugTransport)", () => {
  test("confirmed write actually flips P3 through the real plug-control boundary and restores it", async () => {
    const ui = silence();
    let currentP3 = "1";
    const transport = new FakeWyzeTransport({
      getObjectListHandler: () => fakeGetObjectListEnvelope([{ ...FAKE_PLUG_ONLINE, mac: SAFE_MAC, nickname: SAFE_NAME }]),
      getPropertyListHandler: () => fakePropertyListEnvelope({ P3: currentP3, P5: 1 }),
      setPropertyHandler: (req) => {
        currentP3 = req.value;
        return fakeSetPropertyEnvelope();
      },
    });
    const deps = await baseDeps({ createTransport: () => transport });

    const code = await runRehearsalCommand(deps, false, {
      dryRun: false,
      confirmWrite: true,
      nonInteractiveConfirmTarget: SAFE_NAME,
    });

    expect(code).toBe(ExitCode.Ok);
    expect(currentP3).toBe("1"); // ended up back ON
    ui.restore();
  });
});

describe("runRehearsalCommand — guard 2 wired through the CLI, never the fleet plug", () => {
  test("sameDeviceCheck() returning true -> refused, exit RehearsalRefusedSameAsFleetPlug, never reaches a write", async () => {
    const ui = silence();
    const deps = await baseDeps({ sameDeviceCheck: () => true });
    const code = await runRehearsalCommand(deps, false, {
      dryRun: false,
      confirmWrite: true,
      nonInteractiveConfirmTarget: SAFE_NAME,
    });
    expect(code).toBe(ExitCode.RehearsalRefusedSameAsFleetPlug);
    ui.restore();
  });
});

describe("dispatchRehearsal (src/cli.ts) — the real command-name wiring", () => {
  test("routes to runRehearsalCommand via parseRehearsalArgs, with the real default deps' shape (construction only, no network)", async () => {
    const ui = silence();
    // Real defaultRehearsalCommandDeps hits real credentials/config paths,
    // which do not exist in this test environment — asserting it throws
    // (CredentialsInvalid or ConfigInvalid) rather than reaching the
    // network is what proves this wiring is real, not a stub.
    await expect(dispatchRehearsal(["--dry-run"], false)).rejects.toThrow(CliError);
    ui.restore();
  });
});

describe("defaultRehearsalCommandDeps — real wiring constructors (construction only, no network)", () => {
  test("createTransport() constructs a RealWyzeTransport", () => {
    expect(defaultRehearsalCommandDeps.createTransport()).toBeInstanceOf(RealWyzeTransport);
  });
  test("clock is RealCycleClock", () => {
    expect(defaultRehearsalCommandDeps.clock).toBe(RealCycleClock);
  });
  test("loadConfig() either returns a real WyzrConfig or refuses with ConfigInvalid", () => {
    try {
      const config = defaultRehearsalCommandDeps.loadConfig();
      expect(config.safePlug).toBeDefined();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(ExitCode.ConfigInvalid);
    }
  });
});

describe("realConfirm — the real (non-TTY) path", () => {
  test("returns null immediately when this process is not a TTY", async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    const result = await realConfirm("some-plug-name-fixture");
    expect(result).toBeNull();
  });
});

describe("realConfirm — the TTY path (stdin mocked, never a real terminal)", () => {
  test("prints the prompt naming the configured safe plug's name, then resolves with the typed line, trimmed", async () => {
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
        queueMicrotask(() => listener(Buffer.from("  typed-plug-name-fixture  \n")));
      }
      return stdin;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const result = await realConfirm("typed-plug-name-fixture");

    expect(result).toBe("typed-plug-name-fixture");
    expect(logSpy.mock.calls[0]?.[0]).toContain("typed-plug-name-fixture");
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
