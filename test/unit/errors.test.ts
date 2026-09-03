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
