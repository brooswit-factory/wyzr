import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseArgs, run } from "../../src/cli.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { REDACTED, registerSecret, resetSecretsForTesting } from "../../src/redact.ts";

afterEach(() => {
  resetSecretsForTesting();
});

describe("parseArgs", () => {
  test("parses --json and --help flags out of the positional args", () => {
    expect(parseArgs(["--json", "status", "plug-1"])).toEqual({
      json: true,
      help: false,
      command: "status",
      rest: ["plug-1"],
    });
    expect(parseArgs(["--help"])).toEqual({ json: false, help: true, command: undefined, rest: [] });
    expect(parseArgs(["-h"])).toEqual({ json: false, help: true, command: undefined, rest: [] });
  });

  test("defaults to no command when argv is empty", () => {
    expect(parseArgs([])).toEqual({ json: false, help: false, command: undefined, rest: [] });
  });
});

describe("run — help and no-command path", () => {
  test("prints usage and exits Ok when --help is passed", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const code = await run(["--help"]);
    expect(code).toBe(ExitCode.Ok);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("prints usage and exits Ok when no command is given", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const code = await run([]);
    expect(code).toBe(ExitCode.Ok);
    spy.mockRestore();
  });
});

describe("run — default dispatch (no commands registered yet)", () => {
  test("an unknown command exits Usage and prints to stderr", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["frobnicate"]);
    expect(code).toBe(ExitCode.Usage);
    expect(errSpy).toHaveBeenCalledWith("Unknown command: frobnicate");
    errSpy.mockRestore();
  });
});

describe("run — the try/catch exit-code boundary", () => {
  test("a CliError from dispatch maps to its own exit code, human mode", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["status"], {
      dispatch: async () => {
        throw new CliError("no such device", ExitCode.NotFound, "device_not_found");
      },
    });
    expect(code).toBe(ExitCode.NotFound);
    expect(errSpy).toHaveBeenCalledWith("no such device");
    errSpy.mockRestore();
  });

  test("a CliError from dispatch maps to the documented --json error shape", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["status", "--json"], {
      dispatch: async () => {
        throw new CliError("no such device", ExitCode.NotFound, "device_not_found");
      },
    });
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
    errSpy.mockRestore();

    expect(code).toBe(ExitCode.NotFound);
    expect(JSON.parse(printed)).toEqual({
      error: {
        code: "not_found",
        exitCode: ExitCode.NotFound,
        reason: "device_not_found",
        message: "no such device",
      },
    });
  });

  test("a non-CliError thrown by dispatch is wrapped as Generic", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["status"], {
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    expect(code).toBe(ExitCode.Generic);
    expect(errSpy).toHaveBeenCalledWith("boom");
    errSpy.mockRestore();
  });

  test("a non-Error thrown by dispatch is stringified and wrapped as Generic", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["status"], {
      dispatch: async () => {
        throw "not an Error object";
      },
    });
    expect(code).toBe(ExitCode.Generic);
    expect(errSpy).toHaveBeenCalledWith("not an Error object");
    errSpy.mockRestore();
  });

  test("a successful dispatch's return value is the process exit code", async () => {
    const code = await run(["status"], { dispatch: async () => ExitCode.Ok });
    expect(code).toBe(ExitCode.Ok);
  });

  test("no path through the boundary bypasses redaction — a registered secret in a thrown message never reaches --json stderr", async () => {
    const token = "wyze_live_boundary_secret";
    registerSecret(token);

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    await run(["status", "--json"], {
      dispatch: async () => {
        throw new CliError(`transport failed: Authorization: Bearer ${token}`, ExitCode.Network);
      },
    });
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
    errSpy.mockRestore();

    expect(printed).not.toContain(token);
    expect(printed).toContain(REDACTED);
  });
});
