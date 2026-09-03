#!/usr/bin/env bun
// Entry point: parses argv and is the single boundary that maps whatever a
// command throws to a process exit code. All output (including "unknown
// command") goes through src/output.ts so it can never bypass redaction.
//
// `devices list` is the one registered command so far (this story); every
// other command name is still "unknown" until a later story adds it.
// `dispatch` is injectable so tests can exercise the try/catch boundary, or
// a specific command's routing, without needing real credentials or
// network — see test/unit/cli.test.ts. `dispatchDevices`'s own real-vs-test
// wiring (loadCredentials()/RealWyzeTransport vs. an injected fake) is
// `DevicesDispatchDeps` below, on the same injectable-boundary pattern as
// `WyzeTransport`/`fetchImpl`/`CredentialsEnv` elsewhere in this repo —
// nothing in this repo's test suite touches the filesystem's real
// credentials path or the network.

import { runDevicesList } from "./cli-devices.ts";
import { loadCredentials, type Credentials } from "./credentials.ts";
import { CliError, ExitCode, ExitCodeName } from "./errors.ts";
import { printError, printHuman, printJsonError } from "./output.ts";
import { RealWyzeTransport } from "./transport-http.ts";
import type { WyzeTransport } from "./transport.ts";

export interface ParsedArgs {
  json: boolean;
  help: boolean;
  command: string | undefined;
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let help = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  return { json, help, command, rest };
}

/**
 * Shape of the single JSON value `--json` mode prints to stderr on any
 * error. `code` is the stable ExitCodeName string; `exitCode` is the raw
 * integer for callers that already track it; `reason` is additive
 * finer-grained detail, `null` when the code name alone is specific enough.
 */
function jsonError(err: CliError) {
  return {
    error: {
      code: ExitCodeName[err.exitCode],
      exitCode: err.exitCode,
      reason: err.reason,
      message: err.message,
    },
  };
}

export type Dispatch = (command: string, rest: string[], opts: { json: boolean }) => Promise<number>;

/** How `devices list` obtains the two real things it needs to talk to
 * Wyze, injectable the same way `WyzeTransport`/`fetchImpl`/`CredentialsEnv`
 * are elsewhere in this repo — so this wiring itself is unit-testable
 * (test/unit/cli.test.ts) with zero credentials and zero network, exactly
 * like every other real implementation in this codebase. Production uses
 * `defaultDevicesDispatchDeps` below; nothing in this repo's test suite
 * does — the plain `new RealWyzeTransport()` construction (no network
 * until a method is actually called) is covered directly by
 * test/unit/cli.test.ts, exported for that purpose. */
export interface DevicesDispatchDeps {
  loadCredentials: () => Promise<Credentials>;
  createTransport: () => WyzeTransport;
}

export const defaultDevicesDispatchDeps: DevicesDispatchDeps = {
  loadCredentials,
  createTransport: () => new RealWyzeTransport(),
};

/** The `devices` command's own subcommand routing. Only `list` exists;
 * everything else (including no subcommand at all) is a Usage error. */
export async function dispatchDevices(
  rest: string[],
  json: boolean,
  deps: DevicesDispatchDeps = defaultDevicesDispatchDeps,
): Promise<number> {
  const [sub] = rest;
  if (sub !== "list") {
    throw new CliError(
      sub ? `Unknown devices subcommand: ${sub}` : "Usage: wyzr devices list [--json]",
      ExitCode.Usage,
    );
  }
  const credentials = await deps.loadCredentials();
  const transport = deps.createTransport();
  return runDevicesList({ transport, credentials }, json);
}

const defaultDispatch: Dispatch = async (command, rest, opts) => {
  if (command === "devices") {
    return dispatchDevices(rest, opts.json);
  }
  throw new CliError(`Unknown command: ${command}`, ExitCode.Usage);
};

export interface RunDeps {
  /** Injected for tests; defaults to a stub that reports every command unknown. */
  dispatch?: Dispatch;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const dispatch = deps.dispatch ?? defaultDispatch;

  if (parsed.help || !parsed.command) {
    printHuman(
      "wyzr — a CLI for Wyze devices\n\n" +
        "Usage: wyzr [--json] <command> [args]\n\n" +
        "Commands:\n" +
        "  devices list   List the account's devices.",
    );
    return ExitCode.Ok;
  }

  try {
    return await dispatch(parsed.command, parsed.rest, { json: parsed.json });
  } catch (err) {
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError(err instanceof Error ? err.message : String(err), ExitCode.Generic);

    if (parsed.json) {
      printJsonError(jsonError(cliErr));
    } else {
      printError(cliErr.message);
    }
    return cliErr.exitCode;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
