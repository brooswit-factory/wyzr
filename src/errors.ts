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
  /** `wyzr cycle` (WYZR-19/WYZR-27): refused by the wedge gate — the
   * gate's verdict was NOT_PROVEN or INCONCLUSIVE_BY_SHARED_CAUSE and
   * nothing overrode it (either `--force` was not passed, or a DIFFERENT
   * refusal below fired first — the wrong-box guard and the preconditions
   * are structurally incapable of being skipped by force; see
   * src/cycle-runner.ts). An OUTCOME code, same class as 11/12/13-16
   * above: the command ran the gate and is reporting exactly what it
   * decided — nothing was cut. Produced whether or not `--dry-run` was
   * passed; see CycleDryRunWouldAct below for why dry-run does not get its
   * own refusal codes. */
  CycleRefusedByGate: 17,
  /** `wyzr cycle` only: the wrong-box guard refused — either it
   * affirmatively established this machine IS the configured target, or it
   * could NOT affirmatively establish that it is not (unconfigured target,
   * unreadable local identity, an inconclusive comparison — err tight; see
   * src/cycle-wrong-box.ts). Runs on every path, including `--force` and
   * `--dry-run` — there is no escape hatch, no exceptions. */
  CycleRefusedByWrongBoxGuard: 18,
  /** `wyzr cycle` only: refused by the before-the-cut precondition — the
   * cloud could not be reached, or the plug's P3/P5 could not both be read
   * confidently, immediately before the OFF would have been attempted.
   * This is the CAPABILITY `--force` can never override (D4) — see the
   * "force + gate NOT_PROVEN + cloud unreachable" test in
   * test/unit/cycle-runner.test.ts, the most important test in this
   * story. */
  CycleRefusedByPrecondition: 19,
  /** `wyzr cycle --dry-run` only: every refusal check (gate, wrong-box
   * guard, preconditions) cleared, so a live run at this exact moment
   * would have proceeded to cut power. A dry run that instead refuses
   * reuses whichever of 17/18/19 above names why — a refusal is a refusal
   * whether or not `--dry-run` was passed, since neither path ever writes
   * on that outcome; this code exists solely so a script can tell "dry
   * run: would act" apart from "dry run: would refuse," which the refusal
   * codes alone cannot distinguish from a live refusal. See README's
   * "wyzr cycle" section for the reasoning written out in full. */
  CycleDryRunWouldAct: 20,
  /** `wyzr cycle` only, and the loudest code in this product: the OFF was
   * attempted, the never-give-up ON restore ran to its configured bound,
   * and the plug's own read-back never confirmed "on". The message states
   * (a) power is OFF, (b) the restore was NOT confirmed, (c) the exact
   * single command that restores it by hand. NEVER reported as success —
   * see D1 in the ticket this code was added for. */
  CycleStranded: 21,
  /** `wyzr cycle` only: the plug's own read-back confirmed the restore,
   * but the post-cycle recovery verdict (composed from src/recovery.ts,
   * never reimplemented) was NOT_RECOVERED — the box itself affirmatively
   * did not come back. Distinct from CycleStranded (21): here the PLUG
   * confirms "on", but something broader (reachability/reboot/daemon/
   * instruments) affirmatively failed — no plug-liveness reading may ever
   * stand in for this broader verdict (D6). */
  CycleNotRecovered: 22,
  /** `wyzr cycle` only: the post-cycle recovery verdict was
   * FLEET_HALF_RESTORED — the box itself is confirmed back and rebooted,
   * but the fleet came back with bare (un-flagged) agent processes. Mirrors
   * ExitCode.RecoveryFleetHalfRestored's meaning under `recovery status`,
   * but gets its OWN code rather than reusing 14: that comment (and 15/16's)
   * documents those codes as `recovery status`-only, and this file's own
   * rule is that an existing entry is never reordered, reused, or modified —
   * reusing 14 here would silently break the scope that comment documents. */
  CycleFleetHalfRestored: 23,
  /** `wyzr cycle` only: the post-cycle recovery verdict was INCONCLUSIVE —
   * nothing affirmatively failed, but at least one recovery check could
   * not be read. Same "could-not-look outranks an unconfigured gap"
   * reasoning as ExitCode.RecoveryInconclusive; its own code for the
   * reason CycleFleetHalfRestored's comment gives. */
  CycleRecoveryInconclusive: 24,
  /** `wyzr cycle` only: the post-cycle recovery verdict was UNCONFIGURED —
   * nothing failed and nothing was unreadable; the only gaps are recovery
   * checks nobody pointed anywhere. Same reasoning as
   * ExitCode.RecoveryUnconfigured; its own code for the same reason. */
  CycleRecoveryUnconfigured: 25,
  /** The single configuration surface (WYZR-20/WYZR-28), `src/config.ts`'s
   * `loadWyzrConfig()`: the config file at `<config base>/wyzr/config.json`
   * is missing, unreadable (over-permissive directory or file mode),
   * unparseable, malformed (wrong shape), missing a required value, has a
   * present-but-incomplete optional section, or configures the fleet plug
   * and the safe plug as the same device. ONE code for all of these,
   * mirroring `ExitCode.CredentialsInvalid`'s own precedent exactly: a
   * caller distinguishing "missing file" from "bad permissions" from
   * "incomplete section" needs the `reason` string either way (there is no
   * exit-code-level action a script would take differently between them),
   * so this does not fragment into several new codes for the first
   * config-consuming ticket — see `src/config.ts`'s own `reason` strings
   * (e.g. `config_missing`, `config_file_mode`, `config_field_missing`,
   * `config_plug_conflation`) for the finer-grained detail. */
  ConfigInvalid: 26,
  /** `wyzr doctor` (WYZR-29): at least one check the doctor ran
   * affirmatively FAILED — config or credentials present but broken, a
   * login attempt did not succeed, a configured plug could not be resolved
   * or read, or the wrong-box guard affirmatively found this machine IS the
   * configured target. An OUTCOME code, same class as WedgeNotProven/
   * RecoveryNotRecovered/CycleRefusedByGate above: the doctor ran every
   * check it could and is reporting exactly what it observed — nothing was
   * touched, since `wyzr doctor` is structurally read-only (see
   * test/unit/doctor-imports.test.ts). See src/doctor.ts's evaluateDoctorVerdict()
   * for the precedence this is derived from. */
  DoctorNotReady: 27,
  /** `wyzr doctor` only: nothing affirmatively failed, but at least one
   * check that WAS attempted (config and credentials both loaded, or a
   * genuine I/O attempt was made) could not be read — a DNS/hosts-file
   * lookup failed, a plug's P3/P5 came back undecodable, an instrument
   * probe timed out. Same "could-not-look outranks an unconfigured gap"
   * reasoning as ExitCode.RecoveryInconclusive; its own code for the same
   * reason CycleRecoveryInconclusive's comment gives — this file's own rule
   * is that an existing entry is never reordered, reused, or modified. */
  DoctorInconclusive: 28,
  /** `wyzr doctor` only: nothing failed and nothing was unreadable; the
   * only gaps are things nobody ever pointed anywhere — no config.json at
   * all (a fresh install before setup), or an optional section (jira/
   * github/...) simply never configured. Distinguished from
   * DoctorNotReady/DoctorInconclusive for the same reason
   * ExitCode.RecoveryUnconfigured is distinguished from
   * RecoveryInconclusive: "you never told me where to look" is an
   * operator-fixable setup gap, never possible evidence of a broken
   * install. */
  DoctorUnconfigured: 29,
  /** `wyzr rehearse-safe-plug-write` (WYZR-20/WYZR-30) only: the runtime
   * defense-in-depth check found the configured safe plug resolves to the
   * SAME device as the configured fleet plug. NOT reachable through the
   * real CLI today — `src/config.ts`'s `loadWyzrConfig()` already refuses
   * to construct a `WyzrConfig` where the two conflate (`ExitCode.ConfigInvalid`/
   * `config_plug_conflation`), so any `WyzrConfig` this command holds is
   * already a live proof the two plugs differ. Kept and given its own code
   * anyway, exactly like `src/cli-cycle.ts`'s `resolveForced()` keeps a
   * defensive Usage error for its own "unreachable in practice" branch: a
   * second, independent guard beats relying solely on one upstream check
   * for the one operation in this product that must NEVER reach the fleet
   * plug — see `src/rehearsal-runner.ts`'s own top comment. */
  RehearsalRefusedSameAsFleetPlug: 30,
  /** `wyzr rehearse-safe-plug-write` only: refused by the before-the-cut
   * precondition — the cloud could not be reached, or the safe plug's
   * P3/P5 could not both be read confidently, immediately before the OFF
   * would have been attempted. Composed from the exact same
   * `src/cycle-preconditions.ts` engine `wyzr cycle` uses — see that
   * module's own comment: "an operator who cannot turn the plug back ON
   * must never be allowed to turn it off" applies identically here. */
  RehearsalRefusedByPrecondition: 31,
  /** `wyzr rehearse-safe-plug-write --dry-run` (or the un-confirmed preview
   * printed before the confirmation ceremony) only: every refusal check
   * cleared, so a confirmed run at this exact moment would proceed to cut
   * power on the configured safe plug. Mirrors `ExitCode.CycleDryRunWouldAct`'s
   * own reasoning for why this needs its own code distinct from the two
   * refusals above. */
  RehearsalPreviewWouldWrite: 32,
  /** `wyzr rehearse-safe-plug-write` only, and the loudest code this
   * command can produce: the OFF was attempted, the never-give-up ON
   * restore (composed, never reimplemented, from `src/cycle-runner.ts`'s
   * own `performRestoreNeverGiveUp()`) ran to its configured bound, and the
   * safe plug's own read-back never confirmed "on". NEVER reported as
   * success — mirrors `ExitCode.CycleStranded` exactly, for the safe plug
   * instead of the fleet plug. */
  RehearsalStranded: 33,
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
  [ExitCode.CycleRefusedByGate]: "cycle_refused_by_gate",
  [ExitCode.CycleRefusedByWrongBoxGuard]: "cycle_refused_by_wrong_box_guard",
  [ExitCode.CycleRefusedByPrecondition]: "cycle_refused_by_precondition",
  [ExitCode.CycleDryRunWouldAct]: "cycle_dry_run_would_act",
  [ExitCode.CycleStranded]: "cycle_stranded",
  [ExitCode.CycleNotRecovered]: "cycle_not_recovered",
  [ExitCode.CycleFleetHalfRestored]: "cycle_fleet_half_restored",
  [ExitCode.CycleRecoveryInconclusive]: "cycle_recovery_inconclusive",
  [ExitCode.CycleRecoveryUnconfigured]: "cycle_recovery_unconfigured",
  [ExitCode.ConfigInvalid]: "config_invalid",
  [ExitCode.DoctorNotReady]: "doctor_not_ready",
  [ExitCode.DoctorInconclusive]: "doctor_inconclusive",
  [ExitCode.DoctorUnconfigured]: "doctor_unconfigured",
  [ExitCode.RehearsalRefusedSameAsFleetPlug]: "rehearsal_refused_same_as_fleet_plug",
  [ExitCode.RehearsalRefusedByPrecondition]: "rehearsal_refused_by_precondition",
  [ExitCode.RehearsalPreviewWouldWrite]: "rehearsal_preview_would_write",
  [ExitCode.RehearsalStranded]: "rehearsal_stranded",
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
