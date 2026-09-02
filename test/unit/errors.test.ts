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
    ];
    expect(new Set(codes).size).toBe(codes.length);
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
