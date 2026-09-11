// Typed error taxonomy so a consumer (a later story's command, or a
// downstream automation epic composing this CLI) can tell "no credentials"
// from "no such device" from "transport failed" without parsing English
// prose out of stderr. src/cli.ts is the single boundary that maps a thrown
// error to a process exit code.
//
// Leave room for later stories to add codes without renumbering these:
// append new entries, never reorder or reuse an existing number.

export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  CredentialsInvalid: 3,
  NotFound: 4,
  Network: 5,
  ApiError: 6,
  MfaRequired: 7,
  AmbiguousDevice: 8,
  StateUnknown: 9,
  WriteContradicted: 10,
  /** `wyzr wedge status` (WYZR-17): the engine's verdict was NOT_PROVEN —
   * see src/wedge.ts. An OUTCOME code, not an error code, same class as 9/10
   * above: the command succeeded at running every probe and is reporting
   * exactly what it observed, printing its normal `--json` payload to
   * stdout. This is also this repo's default/refuse-by-default reading: a
   * healthy box, a single silent instrument, an unruled-out shared cause
   * that never got the chance to matter, or a live direct path all land
   * here — see src/cli-wedge.ts's wedgeVerdictExitCode(). */
  WedgeNotProven: 11,
  /** `wyzr wedge status` only: the verdict was INCONCLUSIVE_BY_SHARED_CAUSE
   * — the local-connectivity control itself could not be read, so the
   * shared-cause exclusion (README's "independence trap") could not run,
   * and nothing can be concluded about the suspect box either way. Also an
   * OUTCOME code — "I could not look" is a successful observation, not a
   * failure to run. Deliberately its OWN code, distinct from
   * WedgeNotProven, so a script can tell "not wedged" from "could not
   * look" without parsing prose. */
  WedgeInconclusiveBySharedCause: 12,
  /** `wyzr recovery status` (WYZR-25): the verdict was NOT_RECOVERED — the
   * box affirmatively did not come back, affirmatively did not reboot, or
   * some other check affirmatively failed. An OUTCOME code, same class as
   * 9/10/11/12: the command succeeded at running every probe and is
   * reporting exactly what it observed. See src/recovery.ts. */
  RecoveryNotRecovered: 13,
  /** `wyzr recovery status` only: the box itself is affirmatively back and
   * rebooted, but the fleet came back with bare (un-flagged) agent
   * processes present — the herdr-restore trap. Distinguishable from BOTH
   * RecoveryNotRecovered and success (0) on its own code so a script never
   * has to parse prose to tell "the box didn't come back" from "the box is
   * fine but the fleet needs a manual nudge." wyzr detects and reports
   * this; it does not fix it (WYZR-21 owns the fix). */
  RecoveryFleetHalfRestored: 14,
  /** `wyzr recovery status` only: something load-bearing was LOOKED AT and
   * could not be read, and nothing affirmatively failed — "I looked and
   * could not see," possible evidence about the box. Deliberately its OWN
   * code, distinct from RecoveryUnconfigured below: collapsing the two
   * would mean EVERY run returns the same verdict until WYZR-20 ships
   * (unconfigured is the normal state until then), teaching an operator to
   * stop reading it. See src/recovery.ts's evaluateRecovery() precedence
   * comment. */
  RecoveryInconclusive: 15,
  /** `wyzr recovery status` only: nothing failed and nothing was
   * unreadable — the only gaps are checks nobody ever pointed anywhere.
   * "You never told me where to look" is an operator-fixable setup gap,
   * never possible evidence about the box — see RecoveryInconclusive's own
   * comment for why this must never collapse into it. */
  RecoveryUnconfigured: 16,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Stable, machine-readable name for each ExitCode, for `--json` consumers
 * to switch on instead of memorizing integers. Keep in sync with ExitCode.
 */
export const ExitCodeName: Record<ExitCode, string> = {
  [ExitCode.Ok]: "ok",
  [ExitCode.Generic]: "generic",
  [ExitCode.Usage]: "usage",
  [ExitCode.CredentialsInvalid]: "credentials_invalid",
  [ExitCode.NotFound]: "not_found",
  [ExitCode.Network]: "network",
  [ExitCode.ApiError]: "api_error",
  [ExitCode.MfaRequired]: "mfa_required",
  [ExitCode.AmbiguousDevice]: "ambiguous_device",
  [ExitCode.StateUnknown]: "state_unknown",
  [ExitCode.WriteContradicted]: "write_contradicted",
  [ExitCode.WedgeNotProven]: "wedge_not_proven",
  [ExitCode.WedgeInconclusiveBySharedCause]: "wedge_inconclusive_by_shared_cause",
  [ExitCode.RecoveryNotRecovered]: "recovery_not_recovered",
  [ExitCode.RecoveryFleetHalfRestored]: "recovery_fleet_half_restored",
  [ExitCode.RecoveryInconclusive]: "recovery_inconclusive",
  [ExitCode.RecoveryUnconfigured]: "recovery_unconfigured",
};

export class CliError extends Error {
  readonly exitCode: ExitCode;
  /**
   * Optional finer-grained machine-readable detail beyond ExitCodeName
   * (e.g. distinguishing which resource was "not found"), or `null` when
   * the exit code name alone is specific enough.
   */
  readonly reason: string | null;

  constructor(message: string, exitCode: ExitCode, reason: string | null = null) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.reason = reason;
  }
}
