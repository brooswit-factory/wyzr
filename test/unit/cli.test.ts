import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { defaultDevicesDispatchDeps, dispatchDevices, parseArgs, run } from "../../src/cli.ts";
import type { Credentials } from "../../src/credentials.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { REDACTED, registerSecret, resetSecretsForTesting } from "../../src/redact.ts";
import { FakeWyzeTransport } from "../../src/transport-fake.ts";
import { RealWyzeTransport } from "../../src/transport-http.ts";

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

describe("run — devices command routing (subcommand validation only; the real `devices list` wiring is src/cli-devices.ts's own tests, against the fake transport)", () => {
  test("`devices` with no subcommand is a Usage error, not a network/credentials attempt", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["devices"]);
    expect(code).toBe(ExitCode.Usage);
    expect(errSpy).toHaveBeenCalledWith("Usage: wyzr devices list [--json]");
    errSpy.mockRestore();
  });

  test("`devices frobnicate` (an unknown subcommand) is a Usage error naming it", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["devices", "frobnicate"]);
    expect(code).toBe(ExitCode.Usage);
    expect(errSpy).toHaveBeenCalledWith("Unknown devices subcommand: frobnicate");
    errSpy.mockRestore();
  });

  // Exercises dispatchDevices()'s real (production) wiring shape —
  // loadCredentials() + a transport — with both injected, so this covers
  // the "list" branch (src/cli.ts's own loadCredentials()/RealWyzeTransport
  // call sites are otherwise unreachable from a zero-credentials,
  // zero-network unit suite). See src/cli-devices.ts's own tests for the
  // full behavioral coverage of what runDevicesList() then does.
  test("`devices list` calls the injected loadCredentials + transport and returns Ok", async () => {
    const fakeCreds: Credentials = {
      email: "test-account@example.invalid",
      password: "fake-test-password-000",
      keyId: "fake-key-id-000",
      keySecret: "fake-key-secret-000",
      totpSecret: undefined,
    };
    const transport = new FakeWyzeTransport();
    let loadCredentialsCalls = 0;
    let createTransportCalls = 0;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await dispatchDevices(["list"], true, {
      loadCredentials: async () => {
        loadCredentialsCalls += 1;
        return fakeCreds;
      },
      createTransport: () => {
        createTransportCalls += 1;
        return transport;
      },
    });

    expect(code).toBe(ExitCode.Ok);
    expect(loadCredentialsCalls).toBe(1);
    expect(createTransportCalls).toBe(1);
    logSpy.mockRestore();
  });

  // The production default's transport construction — a plain `new
  // RealWyzeTransport()` performs no I/O until a method on it is actually
  // called, so constructing (never calling) it here is zero-network.
  test("defaultDevicesDispatchDeps.createTransport() constructs a RealWyzeTransport", () => {
    expect(defaultDevicesDispatchDeps.createTransport()).toBeInstanceOf(RealWyzeTransport);
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
