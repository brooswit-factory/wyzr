// Wires `wyzr rehearse-safe-plug-write` together: src/config.ts
// (loadWyzrConfig(), for `.fleetPlug`/`.safePlug`/`.cycle.timing`) +
// src/rehearsal-runner.ts (orchestration) + src/rehearsal-report.ts
// (`--json`/human rendering) + src/output.ts. Same injectable-deps pattern
// as src/cli-wedge.ts/src/cli-recovery.ts/src/cli-cycle.ts —
// `RehearsalCommandDeps` lets test/unit/cli-rehearsal.test.ts exercise this
// module with fakes, zero network, zero credentials, zero real writes.
//
// NO POSITIONAL ARGUMENT NAMES THE TARGET, EVER. Unlike `plug status|on|off`
// and `cycle <device>`, this command takes no device argument at all —
// parseRehearsalArgs() below treats ANY unrecognized token (including what
// would elsewhere be a device query) as a Usage error, never a silently
// ignored extra argument. The safe plug is ALWAYS `config.safePlug`, sourced
// from the ONE configuration surface (src/config.ts) — see
// src/rehearsal-runner.ts's own top comment for the two independent guards
// that keep this the fleet plug's twin, never the fleet plug itself.
//
// THE CONFIRMATION CEREMONY (property 2 of the ticket) LIVES HERE, NOT IN
// src/rehearsal-runner.ts — same split src/cli-cycle.ts's own top comment
// documents for its D4 force ceremony, and for the identical reason: the
// ceremony here is real (it is what makes this a HUMAN-CHOSEN moment, never
// an accidental one) but it is not what makes the operation safe-plug-only
// — the TYPE is (src/rehearsal-runner.ts's guard 1). A bug in this file's
// confirmation logic could at worst make confirming easier or harder than
// intended; it could never make a write reach the fleet plug, because
// nothing in this file can construct a `SafePlugTarget` other than by
// reading it, unmodified, off a real `WyzrConfig`.
//
// NEVER BY DEFAULT (property 4). With NO flags at all, this command runs
// the SAME preview `--dry-run` produces — never a write. Only
// `CONFIRM_WRITE_FLAG` (plus a satisfied confirmation) reaches
// runRehearsalLive() at all.

import { WyzeAuthSession } from "./auth-session.ts";
import type { Credentials } from "./credentials.ts";
import { loadCredentials } from "./credentials.ts";
import type { ResolvedDevice } from "./device-resolve.ts";
import { loadWyzrConfig, type WyzrConfig } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import type { WyzeTransport } from "./transport.ts";
import { RealWyzeTransport } from "./transport-http.ts";
import { RealCyclePlugTransport } from "./cycle-plug.ts";
import { RealCycleClock, type CycleClock } from "./cycle-clock.ts";
import {
  defaultPlugIdentityCheck,
  runRehearsalLive,
  runRehearsalPreview,
  type PlugIdentityCheck,
  type RehearsalResult,
  type RehearsalRunnerDeps,
} from "./rehearsal-runner.ts";
import { formatRehearsalHuman, rehearsalOutcomeExitCode, toRehearsalJson } from "./rehearsal-report.ts";

/** Reads one line from stdin, or `null` when this process cannot prompt —
 * same shape as src/cli-cycle.ts's own `ConfirmFn`, declared separately
 * (not imported from there) because the prompt text genuinely differs: a
 * plug's configured NAME, not a wrong-box target HOST. */
export type ConfirmFn = (safePlugName: string) => Promise<string | null>;

export const realConfirm: ConfirmFn = async (safePlugName) => {
  if (!process.stdin.isTTY) return null;
  printHuman(
    `Type the exact configured safe plug's name ("${safePlugName}") to confirm this human-chosen write rehearsal, ` +
      "then press Enter. Anything else refuses.",
  );
  return await new Promise<string | null>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
};

export interface RehearsalCommandDeps {
  loadCredentials: () => Promise<Credentials>;
  createTransport: () => WyzeTransport;
  loadConfig: () => WyzrConfig;
  clock: CycleClock;
  confirm: ConfirmFn;
  sameDeviceCheck: PlugIdentityCheck;
}

export const defaultRehearsalCommandDeps: RehearsalCommandDeps = {
  loadCredentials,
  createTransport: () => new RealWyzeTransport(),
  loadConfig: () => loadWyzrConfig(),
  clock: RealCycleClock,
  confirm: realConfirm,
  sameDeviceCheck: defaultPlugIdentityCheck,
};

export interface RehearsalCliOptions {
  readonly dryRun: boolean;
  readonly confirmWrite: boolean;
  /** Value of `--non-interactive-confirm-target=<value>`, when given — the
   * separate flag the ceremony requires for the genuinely non-interactive
   * case; `CONFIRM_WRITE_FLAG` alone is never sufficient. */
  readonly nonInteractiveConfirmTarget: string | undefined;
}

// Exported so test/unit/cli-rehearsal.test.ts asserts against the SAME
// literal this module actually parses, rather than a copy that could
// silently drift from it — same discipline as src/cli-cycle.ts's FORCE_FLAG.
export const CONFIRM_WRITE_FLAG = "--confirm-write-i-have-chosen-this-moment";
export const NON_INTERACTIVE_CONFIRM_PREFIX = "--non-interactive-confirm-target=";

/**
 * Parses this command's own flags out of `rest`. Unlike
 * src/cli-cycle.ts's parseCycleArgs() (which collects an unrecognized
 * token as the `<device>` positional), ANY unrecognized token here —
 * including what would elsewhere be a device query — is a Usage error.
 * This is the literal enforcement of "not reachable by a CLI positional
 * argument" (property 1): there is no code path in this parser that lets
 * an extra argument survive to become a plug identifier.
 */
export function parseRehearsalArgs(rest: string[]): RehearsalCliOptions {
  let dryRun = false;
  let confirmWrite = false;
  let nonInteractiveConfirmTarget: string | undefined;
  const unrecognized: string[] = [];

  for (const arg of rest) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === CONFIRM_WRITE_FLAG) {
      confirmWrite = true;
    } else if (arg.startsWith(NON_INTERACTIVE_CONFIRM_PREFIX)) {
      nonInteractiveConfirmTarget = arg.slice(NON_INTERACTIVE_CONFIRM_PREFIX.length);
    } else {
      unrecognized.push(arg);
    }
  }

  if (unrecognized.length > 0) {
    throw new CliError(
      "Usage: wyzr rehearse-safe-plug-write [--dry-run | " +
        `${CONFIRM_WRITE_FLAG} [${NON_INTERACTIVE_CONFIRM_PREFIX}<configured-safe-plug-name>]] [--json] — this ` +
        "command takes NO device argument (the safe plug is always the one configured in config.json, never a " +
        `CLI argument): unexpected argument(s): ${unrecognized.join(" ")}`,
      ExitCode.Usage,
    );
  }

  return { dryRun, confirmWrite, nonInteractiveConfirmTarget };
}

function print(result: RehearsalResult, json: boolean): void {
  if (json) {
    printJson(toRehearsalJson(result));
  } else {
    printHuman(formatRehearsalHuman(result));
  }
}

/**
 * The one function src/cli.ts calls. Never throws for a refusal or
 * `stranded` — those are OUTCOME codes (src/errors.ts), same discipline as
 * every other command in this repo — so this prints the normal
 * evidence-trail payload and RETURNS the code. Only a genuine usage error
 * (an unrecognized argument, both `--dry-run` and the confirm flag given
 * together, a confirmation that was requested but not satisfied) or a
 * transport/auth failure throws, mapped by src/cli.ts's existing error
 * boundary.
 */
export async function runRehearsalCommand(deps: RehearsalCommandDeps, json: boolean, options: RehearsalCliOptions): Promise<number> {
  if (options.dryRun && (options.confirmWrite || options.nonInteractiveConfirmTarget !== undefined)) {
    throw new CliError(
      `Usage: --dry-run cannot be combined with ${CONFIRM_WRITE_FLAG} or ${NON_INTERACTIVE_CONFIRM_PREFIX}<name> — ` +
        "choose one: preview only, or confirm the write.",
      ExitCode.Usage,
    );
  }

  const config = deps.loadConfig();
  const credentials = await deps.loadCredentials();
  const transport = deps.createTransport();
  const session = new WyzeAuthSession({ transport, credentials });
  await session.login();
  const device: ResolvedDevice = { mac: config.safePlug.mac, model: config.safePlug.model, name: config.safePlug.name };
  const plug = new RealCyclePlugTransport(session, device);

  const runnerDeps: RehearsalRunnerDeps = {
    fleetPlug: config.fleetPlug,
    safePlug: config.safePlug,
    clock: deps.clock,
    timing: config.cycle.timing,
    sameDeviceCheck: deps.sameDeviceCheck,
  };

  if (options.dryRun || !options.confirmWrite) {
    // Property 4: no flags at all runs the SAME preview --dry-run does —
    // never a write.
    const result = await runRehearsalPreview(plug, runnerDeps);
    print(result, json);
    return rehearsalOutcomeExitCode(result.outcome);
  }

  // The confirmation ceremony (property 2): print the FULL preview BEFORE
  // asking for anything, same D4 precedent as src/cli-cycle.ts's own
  // resolveForced().
  const preview = await runRehearsalPreview(plug, runnerDeps);
  print(preview, json);

  const targetName = config.safePlug.name;
  if (options.nonInteractiveConfirmTarget !== undefined) {
    if (options.nonInteractiveConfirmTarget !== targetName) {
      throw new CliError(
        `Usage: ${NON_INTERACTIVE_CONFIRM_PREFIX}<name> did not match the configured safe plug's name ` +
          `("${targetName}") exactly — refusing.`,
        ExitCode.Usage,
      );
    }
  } else {
    const typed = await deps.confirm(targetName);
    if (typed === null || typed !== targetName) {
      throw new CliError(
        `Usage: ${CONFIRM_WRITE_FLAG} requires typing the exact configured safe plug's name at the interactive ` +
          `confirmation, or ${NON_INTERACTIVE_CONFIRM_PREFIX}<name> in a non-interactive context — neither was ` +
          "satisfied.",
        ExitCode.Usage,
      );
    }
  }

  const result = await runRehearsalLive(plug, runnerDeps);
  print(result, json);
  return rehearsalOutcomeExitCode(result.outcome);
}
