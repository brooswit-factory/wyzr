#!/usr/bin/env bun
// Entry point: parses argv and is the single boundary that maps whatever a
// command throws to a process exit code. All output (including "unknown
// command") goes through src/output.ts so it can never bypass redaction.
//
// This story is the foundation only — no commands are registered yet (no
// Wyze API/auth/transport/device code belongs here, see the ticket). Every
// command name is therefore "unknown" until a later story adds one.
// `dispatch` is injectable so tests can exercise the try/catch boundary
// below without needing a real command.

import { CliError, ExitCode, ExitCodeName } from "./errors.ts";
import { printError, printHuman, printJsonError } from "./output.ts";

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

export type Dispatch = (command: string, rest: string[]) => Promise<number>;

const defaultDispatch: Dispatch = async (command) => {
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
    printHuman("wyzr — a CLI for Wyze devices\n\nUsage: wyzr [--json] <command> [args]");
    return ExitCode.Ok;
  }

  try {
    return await dispatch(parsed.command, parsed.rest);
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
