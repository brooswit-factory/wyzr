// Aggregates config for `wyzr cycle`. Reuses src/wedge-config.ts's
// `loadWedgeConfigFromEnv()` for the gate's own inputs (jira/github/ssh/
// tunnel-ping/local-connectivity — the SAME `WYZR_WEDGE_*` env vars
// configure the gate here as configure `wyzr wedge status`, because this
// verb calls the exact same gate) and src/recovery-config.ts's
// `loadRecoveryConfigFromEnv()` for the post-cycle verifier's own inputs —
// composing both rather than duplicating either. Only the fields genuinely
// new to this verb — the wrong-box guard's target, the hand-restore
// command, and this verb's own timing bounds — get new env vars below.
// Which device to cycle is NOT one of them: like `plug status|on|off`, it
// is a CLI positional argument (src/cli-cycle.ts), resolved through the
// same src/device-resolve.ts path, not a second, parallel config surface.
//
// Every fleet-specific field (the wrong-box target, the hand-restore
// command) defaults to UNCONFIGURED unless the operator supplies it — same
// discipline as src/wedge-config.ts/src/recovery-config.ts, and for the
// sharpest possible reason here: an unconfigured target must never
// silently fall back to a guess for a verb that cuts real power.

import { loadWedgeConfigFromEnv, positiveIntMs, type WedgeConfig, type WedgeConfigEnv } from "./wedge-config.ts";
import { loadRecoveryConfigFromEnv, type RecoveryConfig, type RecoveryConfigEnv } from "./recovery-config.ts";

export interface CycleTimingConfig {
  /** How long to pause after the OFF attempt before starting the ON
   * never-give-up restore loop. A plain, round, tunable default — NOT
   * derived from the ticket's own n=1 propagation measurement (R3: "that
   * is not a latency budget," see README's "wyzr cycle" section). */
  readonly offToOnWaitMs: number;
  /** Per-attempt read-back retry cadence/bound for the OFF write's
   * read-back (R3: "retried to a configured bound before any
   * conclusion"). Purely evidentiary for OFF — see src/cycle-runner.ts's
   * own comment for why the restore always proceeds regardless of what
   * this concludes (R2). */
  readonly offReadbackPollIntervalMs: number;
  readonly offReadbackBoundMs: number;
  /** Per-attempt read-back retry cadence/bound within EACH restore
   * attempt of the never-give-up loop. */
  readonly restoreReadbackPollIntervalMs: number;
  readonly restoreReadbackBoundMs: number;
  /** The delay between successive ON write attempts in the never-give-up
   * loop (R1: "the ON may be retried"). */
  readonly restorePollIntervalMs: number;
  /** The OUTER bound on the whole never-give-up restore loop (D1:
   * "bounded, with a real timeout") — once this elapses without a
   * confirmed "on" read-back, the run reports STRANDED. */
  readonly restoreTimeoutMs: number;
}

export const DEFAULT_OFF_TO_ON_WAIT_MS = 5_000;
export const DEFAULT_OFF_READBACK_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_OFF_READBACK_BOUND_MS = 20_000;
export const DEFAULT_RESTORE_READBACK_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_RESTORE_READBACK_BOUND_MS = 20_000;
export const DEFAULT_RESTORE_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_RESTORE_TIMEOUT_MS = 5 * 60_000;

export const DEFAULT_CYCLE_TIMING: CycleTimingConfig = {
  offToOnWaitMs: DEFAULT_OFF_TO_ON_WAIT_MS,
  offReadbackPollIntervalMs: DEFAULT_OFF_READBACK_POLL_INTERVAL_MS,
  offReadbackBoundMs: DEFAULT_OFF_READBACK_BOUND_MS,
  restoreReadbackPollIntervalMs: DEFAULT_RESTORE_READBACK_POLL_INTERVAL_MS,
  restoreReadbackBoundMs: DEFAULT_RESTORE_READBACK_BOUND_MS,
  restorePollIntervalMs: DEFAULT_RESTORE_POLL_INTERVAL_MS,
  restoreTimeoutMs: DEFAULT_RESTORE_TIMEOUT_MS,
};

export interface CycleConfig {
  readonly gate: WedgeConfig;
  readonly recovery: RecoveryConfig;
  /** The wrong-box guard's configured target host — see
   * src/cycle-wrong-box.ts. No default. */
  readonly wrongBoxTargetHost: string | undefined;
  /** The exact, operator-facing command printed in a STRANDED outcome —
   * see src/errors.ts's ExitCode.CycleStranded comment. Deliberately
   * CONFIGURED, never hard-coded: this repo names no fleet host, plug
   * name, or device mac anywhere in its own source (the ticket's own
   * rule), and this string is exactly where such a fact would otherwise
   * leak. When unset, `wyzr cycle`'s STRANDED message says so plainly
   * instead of inventing a placeholder. */
  readonly handRestoreCommand: string | undefined;
  readonly timing: CycleTimingConfig;
}

export interface CycleConfigEnv extends WedgeConfigEnv, RecoveryConfigEnv {
  WYZR_CYCLE_WRONG_BOX_TARGET_HOST?: string | undefined;
  WYZR_CYCLE_HAND_RESTORE_COMMAND?: string | undefined;
  WYZR_CYCLE_OFF_TO_ON_WAIT_MS?: string | undefined;
  WYZR_CYCLE_OFF_READBACK_POLL_INTERVAL_MS?: string | undefined;
  WYZR_CYCLE_OFF_READBACK_BOUND_MS?: string | undefined;
  WYZR_CYCLE_RESTORE_READBACK_POLL_INTERVAL_MS?: string | undefined;
  WYZR_CYCLE_RESTORE_READBACK_BOUND_MS?: string | undefined;
  WYZR_CYCLE_RESTORE_POLL_INTERVAL_MS?: string | undefined;
  WYZR_CYCLE_RESTORE_TIMEOUT_MS?: string | undefined;
}

const systemEnv: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export function loadCycleConfigFromEnv(env: CycleConfigEnv = systemEnv): CycleConfig {
  const gate = loadWedgeConfigFromEnv(env);
  const recovery = loadRecoveryConfigFromEnv(env);

  const timing: CycleTimingConfig = {
    offToOnWaitMs: positiveIntMs(env.WYZR_CYCLE_OFF_TO_ON_WAIT_MS, DEFAULT_CYCLE_TIMING.offToOnWaitMs),
    offReadbackPollIntervalMs: positiveIntMs(
      env.WYZR_CYCLE_OFF_READBACK_POLL_INTERVAL_MS,
      DEFAULT_CYCLE_TIMING.offReadbackPollIntervalMs,
    ),
    offReadbackBoundMs: positiveIntMs(env.WYZR_CYCLE_OFF_READBACK_BOUND_MS, DEFAULT_CYCLE_TIMING.offReadbackBoundMs),
    restoreReadbackPollIntervalMs: positiveIntMs(
      env.WYZR_CYCLE_RESTORE_READBACK_POLL_INTERVAL_MS,
      DEFAULT_CYCLE_TIMING.restoreReadbackPollIntervalMs,
    ),
    restoreReadbackBoundMs: positiveIntMs(
      env.WYZR_CYCLE_RESTORE_READBACK_BOUND_MS,
      DEFAULT_CYCLE_TIMING.restoreReadbackBoundMs,
    ),
    restorePollIntervalMs: positiveIntMs(
      env.WYZR_CYCLE_RESTORE_POLL_INTERVAL_MS,
      DEFAULT_CYCLE_TIMING.restorePollIntervalMs,
    ),
    restoreTimeoutMs: positiveIntMs(env.WYZR_CYCLE_RESTORE_TIMEOUT_MS, DEFAULT_CYCLE_TIMING.restoreTimeoutMs),
  };

  return {
    gate,
    recovery,
    wrongBoxTargetHost: nonEmpty(env.WYZR_CYCLE_WRONG_BOX_TARGET_HOST),
    handRestoreCommand: nonEmpty(env.WYZR_CYCLE_HAND_RESTORE_COMMAND),
    timing,
  };
}
