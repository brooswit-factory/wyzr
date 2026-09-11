import { describe, expect, test } from "bun:test";
import { CliError, ExitCode, ExitCodeName } from "../../src/errors.ts";

describe("CliError", () => {
  test("carries a message and exit code", () => {
    const err = new CliError("not found", ExitCode.NotFound);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CliError");
    expect(err.message).toBe("not found");
    expect(err.exitCode).toBe(ExitCode.NotFound);
  });

  test("defaults reason to null when not given", () => {
    const err = new CliError("bad args", ExitCode.Usage);
    expect(err.reason).toBeNull();
  });

  test("carries reason when given", () => {
    const err = new CliError("no such plug", ExitCode.NotFound, "device_not_found");
    expect(err.reason).toBe("device_not_found");
  });
});

describe("ExitCode", () => {
  test("keeps 0/1/2 as success/generic/usage", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
  });

  test("every required meaning has a distinct code", () => {
    const codes = [
      ExitCode.Ok,
      ExitCode.Generic,
      ExitCode.Usage,
      ExitCode.CredentialsInvalid,
      ExitCode.NotFound,
      ExitCode.Network,
      ExitCode.ApiError,
      ExitCode.MfaRequired,
      ExitCode.AmbiguousDevice,
      ExitCode.StateUnknown,
      ExitCode.WriteContradicted,
      ExitCode.WedgeNotProven,
      ExitCode.WedgeInconclusiveBySharedCause,
      ExitCode.RecoveryNotRecovered,
      ExitCode.RecoveryFleetHalfRestored,
      ExitCode.RecoveryInconclusive,
      ExitCode.RecoveryUnconfigured,
      ExitCode.CycleRefusedByGate,
      ExitCode.CycleRefusedByWrongBoxGuard,
      ExitCode.CycleRefusedByPrecondition,
      ExitCode.CycleDryRunWouldAct,
      ExitCode.CycleStranded,
      ExitCode.CycleNotRecovered,
      ExitCode.CycleFleetHalfRestored,
      ExitCode.CycleRecoveryInconclusive,
      ExitCode.CycleRecoveryUnconfigured,
      ExitCode.ConfigInvalid,
      ExitCode.DoctorNotReady,
      ExitCode.DoctorInconclusive,
      ExitCode.DoctorUnconfigured,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  // WYZR-13 decision (B): append-only — 0-7 must never move.
  test("0-7 are untouched by WYZR-13's additions", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.CredentialsInvalid).toBe(3);
    expect(ExitCode.NotFound).toBe(4);
    expect(ExitCode.Network).toBe(5);
    expect(ExitCode.ApiError).toBe(6);
    expect(ExitCode.MfaRequired).toBe(7);
  });

  test("WYZR-13 appends 8/9/10 as ambiguous_device/state_unknown/write_contradicted", () => {
    expect(ExitCode.AmbiguousDevice).toBe(8);
    expect(ExitCode.StateUnknown).toBe(9);
    expect(ExitCode.WriteContradicted).toBe(10);
  });

  // WYZR-17 decision: append-only continues — 0-10 must never move.
  test("0-10 are untouched by WYZR-17's/WYZR-25's additions", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.CredentialsInvalid).toBe(3);
    expect(ExitCode.NotFound).toBe(4);
    expect(ExitCode.Network).toBe(5);
    expect(ExitCode.ApiError).toBe(6);
    expect(ExitCode.MfaRequired).toBe(7);
    expect(ExitCode.AmbiguousDevice).toBe(8);
    expect(ExitCode.StateUnknown).toBe(9);
    expect(ExitCode.WriteContradicted).toBe(10);
  });

  test("WYZR-17 appends 11/12 as wedge_not_proven/wedge_inconclusive_by_shared_cause", () => {
    expect(ExitCode.WedgeNotProven).toBe(11);
    expect(ExitCode.WedgeInconclusiveBySharedCause).toBe(12);
  });

  // WYZR-25 decision: append-only continues — 0-12 must never move. Verified
  // by reading this repo's highest existing code (12, WYZR-17's) before
  // appending, per the ticket's explicit instruction to verify rather than
  // trust a number relayed in the ticket text.
  test("0-12 are untouched by WYZR-25's additions", () => {
    expect(ExitCode.WedgeNotProven).toBe(11);
    expect(ExitCode.WedgeInconclusiveBySharedCause).toBe(12);
  });

  test("WYZR-25 appends 13/14/15/16 for the four non-RECOVERED recovery verdicts", () => {
    expect(ExitCode.RecoveryNotRecovered).toBe(13);
    expect(ExitCode.RecoveryFleetHalfRestored).toBe(14);
    expect(ExitCode.RecoveryInconclusive).toBe(15);
    expect(ExitCode.RecoveryUnconfigured).toBe(16);
  });

  // WYZR-27 decision: append-only continues — 0-16 must never move.
  // Verified by reading this repo's highest existing code (16, WYZR-25's)
  // before appending, per the ticket's explicit instruction to verify
  // rather than trust a number relayed in the ticket text.
  test("0-16 are untouched by WYZR-27's additions", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.CredentialsInvalid).toBe(3);
    expect(ExitCode.NotFound).toBe(4);
    expect(ExitCode.Network).toBe(5);
    expect(ExitCode.ApiError).toBe(6);
    expect(ExitCode.MfaRequired).toBe(7);
    expect(ExitCode.AmbiguousDevice).toBe(8);
    expect(ExitCode.StateUnknown).toBe(9);
    expect(ExitCode.WriteContradicted).toBe(10);
    expect(ExitCode.WedgeNotProven).toBe(11);
    expect(ExitCode.WedgeInconclusiveBySharedCause).toBe(12);
    expect(ExitCode.RecoveryNotRecovered).toBe(13);
    expect(ExitCode.RecoveryFleetHalfRestored).toBe(14);
    expect(ExitCode.RecoveryInconclusive).toBe(15);
    expect(ExitCode.RecoveryUnconfigured).toBe(16);
  });

  test("WYZR-27 appends 17-25 for wyzr cycle's outcome classes", () => {
    expect(ExitCode.CycleRefusedByGate).toBe(17);
    expect(ExitCode.CycleRefusedByWrongBoxGuard).toBe(18);
    expect(ExitCode.CycleRefusedByPrecondition).toBe(19);
    expect(ExitCode.CycleDryRunWouldAct).toBe(20);
    expect(ExitCode.CycleStranded).toBe(21);
    expect(ExitCode.CycleNotRecovered).toBe(22);
    expect(ExitCode.CycleFleetHalfRestored).toBe(23);
    expect(ExitCode.CycleRecoveryInconclusive).toBe(24);
    expect(ExitCode.CycleRecoveryUnconfigured).toBe(25);
  });

  // WYZR-28 decision: append-only continues — 0-25 must never move.
  // Verified by reading this repo's highest existing code (25, WYZR-27's)
  // before appending, per the ticket's explicit instruction to verify
  // rather than trust a number relayed in the ticket text.
  test("0-25 are untouched by WYZR-28's additions", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.CredentialsInvalid).toBe(3);
    expect(ExitCode.NotFound).toBe(4);
    expect(ExitCode.Network).toBe(5);
    expect(ExitCode.ApiError).toBe(6);
    expect(ExitCode.MfaRequired).toBe(7);
    expect(ExitCode.AmbiguousDevice).toBe(8);
    expect(ExitCode.StateUnknown).toBe(9);
    expect(ExitCode.WriteContradicted).toBe(10);
    expect(ExitCode.WedgeNotProven).toBe(11);
    expect(ExitCode.WedgeInconclusiveBySharedCause).toBe(12);
    expect(ExitCode.RecoveryNotRecovered).toBe(13);
    expect(ExitCode.RecoveryFleetHalfRestored).toBe(14);
    expect(ExitCode.RecoveryInconclusive).toBe(15);
    expect(ExitCode.RecoveryUnconfigured).toBe(16);
    expect(ExitCode.CycleRefusedByGate).toBe(17);
    expect(ExitCode.CycleRefusedByWrongBoxGuard).toBe(18);
    expect(ExitCode.CycleRefusedByPrecondition).toBe(19);
    expect(ExitCode.CycleDryRunWouldAct).toBe(20);
    expect(ExitCode.CycleStranded).toBe(21);
    expect(ExitCode.CycleNotRecovered).toBe(22);
    expect(ExitCode.CycleFleetHalfRestored).toBe(23);
    expect(ExitCode.CycleRecoveryInconclusive).toBe(24);
    expect(ExitCode.CycleRecoveryUnconfigured).toBe(25);
  });

  test("WYZR-28 appends 26 as config_invalid — the single configuration surface's one refusal code", () => {
    expect(ExitCode.ConfigInvalid).toBe(26);
    expect(ExitCodeName[ExitCode.ConfigInvalid]).toBe("config_invalid");
  });

  // WYZR-29 decision: append-only continues — 0-26 must never move.
  // Verified by reading this repo's highest existing code (26, WYZR-28's)
  // before appending, per the ticket's explicit instruction to verify
  // rather than trust a number relayed in the ticket text.
  test("0-26 are untouched by WYZR-29's additions", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.CredentialsInvalid).toBe(3);
    expect(ExitCode.NotFound).toBe(4);
    expect(ExitCode.Network).toBe(5);
    expect(ExitCode.ApiError).toBe(6);
    expect(ExitCode.MfaRequired).toBe(7);
    expect(ExitCode.AmbiguousDevice).toBe(8);
    expect(ExitCode.StateUnknown).toBe(9);
    expect(ExitCode.WriteContradicted).toBe(10);
    expect(ExitCode.WedgeNotProven).toBe(11);
    expect(ExitCode.WedgeInconclusiveBySharedCause).toBe(12);
    expect(ExitCode.RecoveryNotRecovered).toBe(13);
    expect(ExitCode.RecoveryFleetHalfRestored).toBe(14);
    expect(ExitCode.RecoveryInconclusive).toBe(15);
    expect(ExitCode.RecoveryUnconfigured).toBe(16);
    expect(ExitCode.CycleRefusedByGate).toBe(17);
    expect(ExitCode.CycleRefusedByWrongBoxGuard).toBe(18);
    expect(ExitCode.CycleRefusedByPrecondition).toBe(19);
    expect(ExitCode.CycleDryRunWouldAct).toBe(20);
    expect(ExitCode.CycleStranded).toBe(21);
    expect(ExitCode.CycleNotRecovered).toBe(22);
    expect(ExitCode.CycleFleetHalfRestored).toBe(23);
    expect(ExitCode.CycleRecoveryInconclusive).toBe(24);
    expect(ExitCode.CycleRecoveryUnconfigured).toBe(25);
    expect(ExitCode.ConfigInvalid).toBe(26);
  });

  test("WYZR-29 appends 27/28/29 for wyzr doctor's own outcome classes", () => {
    expect(ExitCode.DoctorNotReady).toBe(27);
    expect(ExitCode.DoctorInconclusive).toBe(28);
    expect(ExitCode.DoctorUnconfigured).toBe(29);
    expect(ExitCodeName[ExitCode.DoctorNotReady]).toBe("doctor_not_ready");
    expect(ExitCodeName[ExitCode.DoctorInconclusive]).toBe("doctor_inconclusive");
    expect(ExitCodeName[ExitCode.DoctorUnconfigured]).toBe("doctor_unconfigured");
  });
});

describe("ExitCodeName", () => {
  test("has a stable string name for every ExitCode", () => {
    for (const code of Object.values(ExitCode)) {
      expect(typeof ExitCodeName[code]).toBe("string");
      expect(ExitCodeName[code].length).toBeGreaterThan(0);
    }
  });

  test("names are unique", () => {
    const names = Object.values(ExitCodeName);
    expect(new Set(names).size).toBe(names.length);
  });
});
