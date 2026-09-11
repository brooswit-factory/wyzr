// The CycleConfig/CycleTimingConfig shapes for `wyzr cycle`.
//
// WYZR-20/WYZR-28: this module used to ALSO own `loadCycleConfigFromEnv()`,
// a provisional env-var-backed loader composing src/wedge-config.ts's
// `loadWedgeConfigFromEnv()` (the gate's own inputs) and
// src/recovery-config.ts's `loadRecoveryConfigFromEnv()` (the post-cycle
// verifier's own inputs) with a handful of genuinely new fields (the
// wrong-box guard's target, the hand-restore command, this verb's own
// timing bounds). That loader has been REMOVED: `src/config.ts`'s
// `loadWyzrConfig()` is now the ONE configuration surface — see that
// module's own top comment for the ruling, and for why `wrongBoxTargetHost`
// is no longer its own independently-settable value at all: it is now the
// SAME required `suspectBox` host the gate's own ssh direct path uses,
// deliberately, so a file/env (or, now, a file-internal) disagreement
// between "which box is wedged" and "which box the wrong-box guard is
// guarding" cannot exist.
//
// Which device to cycle is STILL not one of these fields: like `plug
// status|on|off`, it is a CLI positional argument (src/cli-cycle.ts),
// resolved through the same src/device-resolve.ts path, not a config
// surface. (`src/config.ts`'s `fleetPlug`/`safePlug` are a SEPARATE concern
// — identifiers a later task's write-rehearsal command will consume, not
// wired into this verb's own device resolution.)
//
// Every fleet-specific field (the wrong-box target, the hand-restore
// command) still defaults to UNCONFIGURED unless the operator supplies it —
// same discipline as before, and for the sharpest possible reason here: an
// unconfigured target must never silently fall back to a guess for a verb
// that cuts real power. In practice, since the suspect box's host is now a
// REQUIRED top-level config value, `wrongBoxTargetHost` is always populated
// in any config that loads at all — a deliberate strengthening over the
// old env loader, where it could be left unconfigured independently of
// everything else (see src/config.ts's own comment).

import type { WedgeConfig } from "./wedge-config.ts";
import type { RecoveryConfig } from "./recovery-config.ts";

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
   * src/cycle-wrong-box.ts. No default; always populated in any config
   * loaded by src/config.ts (see this module's own top comment). */
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
