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
import { runPlugStatus, runPlugWrite } from "./cli-plug.ts";
import { defaultWedgeStatusDeps, runWedgeStatus, type WedgeStatusDeps } from "./cli-wedge.ts";
import { defaultRecoveryStatusDeps, runRecoveryStatus, type RecoveryStatusDeps } from "./cli-recovery.ts";
import { defaultCycleCommandDeps, parseCycleArgs, runCycleCommand, type CycleCommandDeps } from "./cli-cycle.ts";
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

/** Same injectable-wiring pattern as DevicesDispatchDeps above, for `plug`. */
export interface PlugDispatchDeps {
  loadCredentials: () => Promise<Credentials>;
  createTransport: () => WyzeTransport;
}

export const defaultPlugDispatchDeps: PlugDispatchDeps = {
  loadCredentials,
  createTransport: () => new RealWyzeTransport(),
};

/** `plug`'s own subcommand routing: `status`, `on`, `off`, each requiring
 * exactly one `<device>` argument (a mac or a name — see
 * src/device-resolve.ts). Anything else — no subcommand, an unrecognized
 * one, or a recognized one with no device argument — is a Usage error. */
export async function dispatchPlug(
  rest: string[],
  json: boolean,
  deps: PlugDispatchDeps = defaultPlugDispatchDeps,
): Promise<number> {
  const [sub, device] = rest;
  if (sub !== "status" && sub !== "on" && sub !== "off") {
    throw new CliError(
      sub ? `Unknown plug subcommand: ${sub}` : "Usage: wyzr plug <status|on|off> <device> [--json]",
      ExitCode.Usage,
    );
  }
  if (!device) {
    throw new CliError(`Usage: wyzr plug ${sub} <device> [--json]`, ExitCode.Usage);
  }
  const credentials = await deps.loadCredentials();
  const transport = deps.createTransport();
  if (sub === "status") {
    return runPlugStatus({ transport, credentials }, device, json);
  }
  return runPlugWrite({ transport, credentials }, device, sub, json);
}

/** `wedge`'s own subcommand routing: only `status` exists, and it is
 * READ-ONLY — see src/cli-wedge.ts's own top comment for why there is no
 * import path from it to a write verb at all, structurally, not by
 * convention. */
export async function dispatchWedge(
  rest: string[],
  json: boolean,
  deps: WedgeStatusDeps = defaultWedgeStatusDeps,
): Promise<number> {
  const [sub] = rest;
  if (sub !== "status") {
    throw new CliError(sub ? `Unknown wedge subcommand: ${sub}` : "Usage: wyzr wedge status [--json]", ExitCode.Usage);
  }
  return runWedgeStatus(deps, json);
}

/** `recovery`'s own subcommand routing: only `status` exists, and it is
 * READ-ONLY — see src/cli-recovery.ts's own top comment for why there is no
 * import path from it to a write verb, or to the Wyze plug/transport
 * modules at all, structurally, not by convention.
 *
 * `--since <ISO-8601 timestamp>` is REQUIRED, with no default — a guess
 * here ("now minus something") would silently change the verdict, per the
 * ticket. It is parsed out of `rest` here (rather than added to
 * src/cli.ts's global `parseArgs()`) because it is specific to this one
 * command, the same way `<device>` is specific to `plug`. Missing,
 * unparseable, or future-dated is a Usage error — never a verdict. */
export async function dispatchRecovery(
  rest: string[],
  json: boolean,
  deps: RecoveryStatusDeps = defaultRecoveryStatusDeps,
  now?: number,
): Promise<number> {
  const usage = "Usage: wyzr recovery status --since <ISO-8601 timestamp> [--json]";
  const sinceIndex = rest.indexOf("--since");
  const filteredRest = [...rest];
  let sinceValue: string | undefined;
  if (sinceIndex !== -1) {
    sinceValue = rest[sinceIndex + 1];
    filteredRest.splice(sinceIndex, 2);
  }

  const [sub] = filteredRest;
  if (sub !== "status") {
    throw new CliError(sub ? `Unknown recovery subcommand: ${sub}` : usage, ExitCode.Usage);
  }
  if (!sinceValue) {
    throw new CliError(`${usage} — --since is required; there is no default`, ExitCode.Usage);
  }
  const sinceMs = Date.parse(sinceValue);
  if (Number.isNaN(sinceMs)) {
    throw new CliError(`${usage} — could not parse --since as an ISO-8601 timestamp: ${JSON.stringify(sinceValue)}`, ExitCode.Usage);
  }
  const nowMs = now ?? Date.now();
  if (sinceMs > nowMs) {
    throw new CliError(
      `${usage} — --since (${new Date(sinceMs).toISOString()}) is in the future; this must be the moment power was actually cut, never a guess`,
      ExitCode.Usage,
    );
  }
  return runRecoveryStatus(deps, json, sinceMs, now);
}

/** `cycle`'s own subcommand routing: no subcommand at all — unlike
 * `plug`/`wedge`/`recovery`, `cycle` has exactly one behavior, so its first
 * positional argument is the `<device>` (mac or name — see
 * src/device-resolve.ts), not a verb. `--dry-run`, the long force flag, and
 * the non-interactive confirmation flag are parsed by
 * src/cli-cycle.ts's parseCycleArgs() — see that module's own comment for
 * why the force ceremony lives there rather than here. */
export async function dispatchCycle(
  rest: string[],
  json: boolean,
  deps: CycleCommandDeps = defaultCycleCommandDeps,
): Promise<number> {
  const { device, options } = parseCycleArgs(rest);
  if (!device) {
    throw new CliError(
      "Usage: wyzr cycle <device> [--dry-run] [--json] [--force-override-gate-verdict-i-accept-the-risk] " +
        "[--force-non-interactive-confirm-target=<target>]",
      ExitCode.Usage,
    );
  }
  return runCycleCommand(deps, device, json, options);
}

const defaultDispatch: Dispatch = async (command, rest, opts) => {
  if (command === "devices") {
    return dispatchDevices(rest, opts.json);
  }
  if (command === "plug") {
    return dispatchPlug(rest, opts.json);
  }
  if (command === "wedge") {
    return dispatchWedge(rest, opts.json);
  }
  if (command === "recovery") {
    return dispatchRecovery(rest, opts.json);
  }
  if (command === "cycle") {
    return dispatchCycle(rest, opts.json);
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
        "  devices list           List the account's devices.\n" +
        "  plug status <device>   Report whether a plug is on/off, and reachable.\n" +
        "  plug on <device>       Turn a plug on (read back to confirm).\n" +
        "  plug off <device>      Turn a plug off (read back to confirm).\n" +
        "  wedge status           Report the wedge-proof engine's full evidence trail and verdict (read-only).\n" +
        "  recovery status --since <ISO-8601 timestamp>\n" +
        "                          Report post-cycle recovery evidence and verdict (read-only).\n" +
        "  cycle <device> [--dry-run]\n" +
        "                          Gated power cycle: off, wait, never-give-up on, then a recovery\n" +
        "                          verdict. DESTRUCTIVE. --dry-run is the only way to exercise this\n" +
        "                          verb's judgment without cutting power. See README's \"wyzr cycle\"\n" +
        "                          section before ever running this for real.",
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
