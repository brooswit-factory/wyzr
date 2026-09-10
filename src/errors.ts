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
