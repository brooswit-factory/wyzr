import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CYCLE_TIMING,
  loadCycleConfigFromEnv,
  type CycleConfigEnv,
} from "../../src/cycle-config.ts";
import { DEFAULT_LOCAL_CONNECTIVITY_TARGET } from "../../src/wedge-config.ts";

describe("loadCycleConfigFromEnv — unconfigured is the default, never a guess for anything fleet-specific", () => {
  test("an entirely empty env: wrong-box target and hand-restore command are unconfigured, timing falls back to documented defaults", () => {
    const config = loadCycleConfigFromEnv({});
    expect(config.wrongBoxTargetHost).toBeUndefined();
    expect(config.handRestoreCommand).toBeUndefined();
    expect(config.timing).toEqual(DEFAULT_CYCLE_TIMING);
  });

  test("the gate config is composed from loadWedgeConfigFromEnv verbatim — the SAME WYZR_WEDGE_* vars configure both", () => {
    const env: CycleConfigEnv = { WYZR_WEDGE_SSH_HOST: "example-host-fixture" };
    const config = loadCycleConfigFromEnv(env);
    expect(config.gate.ssh?.host).toBe("example-host-fixture");
    expect(config.gate.localConnectivity.target).toBe(DEFAULT_LOCAL_CONNECTIVITY_TARGET);
  });

  test("the recovery config is composed from loadRecoveryConfigFromEnv verbatim, including its ssh-reuse rule for the new probes", () => {
    const env: CycleConfigEnv = {
      WYZR_WEDGE_SSH_HOST: "example-host-fixture",
      WYZR_RECOVERY_DAEMON_UNIT: "example.service",
      WYZR_RECOVERY_DAEMON_SCOPE: "user",
    };
    const config = loadCycleConfigFromEnv(env);
    expect(config.recovery.daemon?.unit).toBe("example.service");
    expect(config.recovery.daemon?.host).toBe("example-host-fixture");
  });

  test("wrong-box target and hand-restore command are populated only when explicitly configured, and blank/whitespace-only counts as unconfigured", () => {
    const configured = loadCycleConfigFromEnv({
      WYZR_CYCLE_WRONG_BOX_TARGET_HOST: "target-fixture.invalid",
      WYZR_CYCLE_HAND_RESTORE_COMMAND: "fixture-restore-command --by-hand",
    });
    expect(configured.wrongBoxTargetHost).toBe("target-fixture.invalid");
    expect(configured.handRestoreCommand).toBe("fixture-restore-command --by-hand");

    const blank = loadCycleConfigFromEnv({ WYZR_CYCLE_WRONG_BOX_TARGET_HOST: "   " });
    expect(blank.wrongBoxTargetHost).toBeUndefined();
  });

  test("every timing field is independently overridable, and an invalid override falls back to its own documented default rather than NaN", () => {
    const overridden = loadCycleConfigFromEnv({
      WYZR_CYCLE_OFF_TO_ON_WAIT_MS: "9999",
      WYZR_CYCLE_RESTORE_TIMEOUT_MS: "not-a-number",
    });
    expect(overridden.timing.offToOnWaitMs).toBe(9999);
    expect(overridden.timing.restoreTimeoutMs).toBe(DEFAULT_CYCLE_TIMING.restoreTimeoutMs);
    expect(Number.isFinite(overridden.timing.restoreTimeoutMs)).toBe(true);
  });
});
