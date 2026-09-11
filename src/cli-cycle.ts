// Wires `wyzr cycle <device>` together: src/cycle-config.ts (config) +
// src/wedge-probes-real.ts (gate probes, reused) + src/recovery-probes-real.ts
// (recovery probes, reused) + src/cycle-plug.ts (the real plug transport,
// wrapping WyzeAuthSession + a resolved device) + src/cycle-wrong-box.ts
// (the real local-identity probe) + src/cycle-clock.ts (RealCycleClock) +
// src/cycle-runner.ts (orchestration) + src/output.ts. Same injectable-deps
// pattern as src/cli-wedge.ts/src/cli-recovery.ts — `CycleCommandDeps` lets
// test/unit/cli-cycle.test.ts exercise this module with fakes, zero
// network, zero credentials, zero real writes.
//
// THE FORCE CEREMONY (D4) LIVES HERE, NOT IN src/cycle-runner.ts: the long,
// explicit flag; the "print full evidence before acting" requirement; the
// interactive-or-non-interactive confirmation naming the target. This is
// deliberate — D4's STRUCTURAL guarantee (force cannot skip the
// preconditions) is enforced by src/cycle-preconditions.ts's witness type,
// which does not care how `forced: boolean` was decided. The ceremony here
// is real but not what makes force safe; the witness is. A bug in this
// file's confirmation logic could at worst make `--force` easier or harder
// to invoke than intended — it could never make force skip a precondition,
// because nothing in this file can construct a
// PreconditionsClearedWitness.
//
// For the "print full evidence before acting" requirement specifically:
// this module runs runCycleDryRun() FIRST whenever `--force` is passed
// (even for what will become a live run), prints that preview in full, and
// only then asks for confirmation. Re-evaluating the preamble a second
// time (inside the real runCycleLive() call that follows a confirmed
// force) is not wasted work — D1 requires the precondition to be checked
// "immediately before" the OFF, and real time has passed while the human
// read the preview and typed a confirmation.

import { WyzeAuthSession } from "./auth-session.ts";
import type { Credentials } from "./credentials.ts";
import { loadCredentials } from "./credentials.ts";
import { resolveDevice } from "./device-resolve.ts";
import { projectDeviceList } from "./devices.ts";
import { CliError, ExitCode } from "./errors.ts";
import { printHuman, printJson } from "./output.ts";
import type { WyzeTransport } from "./transport.ts";
import { RealWyzeTransport } from "./transport-http.ts";
import { RealWedgeProbes } from "./wedge-probes-real.ts";
import type { WedgeProbes } from "./wedge-probes.ts";
import { RealRecoveryProbes } from "./recovery-probes-real.ts";
import type { RecoveryProbes } from "./recovery-probes.ts";
import type { CycleConfig } from "./cycle-config.ts";
import { loadWyzrConfig } from "./config.ts";
import { RealCyclePlugTransport, type PlugWriter } from "./cycle-plug.ts";
import { RealWrongBoxIdentityProbe, type WrongBoxIdentityProbe } from "./cycle-wrong-box.ts";
import { RealCycleClock, type CycleClock } from "./cycle-clock.ts";
import { runCycleDryRun, runCycleLive, type CycleRunnerDeps } from "./cycle-runner.ts";
import type { CycleResult } from "./cycle.ts";
import { cycleOutcomeExitCode, formatCycleHuman, toCycleJson } from "./cycle-report.ts";

/** Reads one line from stdin, or `null` when this process cannot prompt
 * (not a TTY) — the real implementation of the confirmation D4 requires.
 * Injectable so tests never touch a real terminal. */
export type ConfirmFn = (targetHost: string) => Promise<string | null>;

export const realConfirm: ConfirmFn = async (targetHost) => {
  if (!process.stdin.isTTY) return null;
  printHuman(
    `Type the exact configured target host name ("${targetHost}") to confirm this human-forced power cycle, ` +
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

export interface CycleCommandDeps {
  loadCredentials: () => Promise<Credentials>;
  createTransport: () => WyzeTransport;
  loadConfig: () => CycleConfig;
  createGateProbes: () => WedgeProbes;
  createRecoveryWedgeProbes: () => WedgeProbes;
  createRecoveryProbes: () => RecoveryProbes;
  createIdentityProbe: () => WrongBoxIdentityProbe;
  clock: CycleClock;
  confirm: ConfirmFn;
}

export const defaultCycleCommandDeps: CycleCommandDeps = {
  loadCredentials,
  createTransport: () => new RealWyzeTransport(),
  loadConfig: () => loadWyzrConfig().cycle,
  createGateProbes: () => new RealWedgeProbes(),
  createRecoveryWedgeProbes: () => new RealWedgeProbes(),
  createRecoveryProbes: () => new RealRecoveryProbes(),
  createIdentityProbe: () => new RealWrongBoxIdentityProbe(),
  clock: RealCycleClock,
  confirm: realConfirm,
};

export interface CycleCliOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  /** Value of `--force-non-interactive-confirm-target=<value>`, when
   * given — the separate flag D4 requires for the genuinely non-
   * interactive case; `--force` alone is never sufficient. */
  readonly nonInteractiveConfirmTarget: string | undefined;
}

// Exported so test/unit/cli-cycle.test.ts asserts against the SAME
// literal this module actually parses, rather than a copy that could
// silently drift from it.
export const FORCE_FLAG = "--force-override-gate-verdict-i-accept-the-risk";
export const NON_INTERACTIVE_CONFIRM_PREFIX = "--force-non-interactive-confirm-target=";
const NON_INTERACTIVE_PREFIX = NON_INTERACTIVE_CONFIRM_PREFIX;

/** Parses `cycle`-specific flags out of `rest`, leaving the positional
 * `<device>` argument as the only thing left. Mirrors
 * src/cli.ts's dispatchRecovery()'s own inline-flag-parsing shape for a
 * command-specific flag that does not belong in the global parseArgs(). */
export function parseCycleArgs(rest: string[]): { device: string | undefined; options: CycleCliOptions } {
  const positional: string[] = [];
  let dryRun = false;
  let force = false;
  let nonInteractiveConfirmTarget: string | undefined;

  for (const arg of rest) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === FORCE_FLAG) {
      force = true;
    } else if (arg.startsWith(NON_INTERACTIVE_PREFIX)) {
      nonInteractiveConfirmTarget = arg.slice(NON_INTERACTIVE_PREFIX.length);
    } else {
      positional.push(arg);
    }
  }

  return { device: positional[0], options: { dryRun, force, nonInteractiveConfirmTarget } };
}

function buildRunnerDeps(
  config: CycleConfig,
  deps: CycleCommandDeps,
  forced: boolean,
): Omit<CycleRunnerDeps, "clock"> & { clock: CycleClock } {
  return {
    gateConfig: config.gate,
    gateProbes: deps.createGateProbes(),
    configuredTargetHost: config.wrongBoxTargetHost,
    identityProbe: deps.createIdentityProbe(),
    recoveryConfig: config.recovery,
    recoveryWedgeProbes: deps.createRecoveryWedgeProbes(),
    recoveryProbes: deps.createRecoveryProbes(),
    clock: deps.clock,
    timing: config.timing,
    forced,
    handRestoreCommand: config.handRestoreCommand,
  };
}

/**
 * Decides `forced` for the real run, carrying out D4's ceremony when
 * `--force` was passed: prints the FULL unforced preview (gate, wrong-box
 * guard, preconditions, and what they would decide) BEFORE asking for
 * anything, then requires either the interactive confirmation (naming the
 * target) or the separate non-interactive flag (also naming the target) —
 * the force flag alone is never sufficient (test 6: "force flag WITHOUT
 * its confirmation -> refuses").
 */
async function resolveForced(
  plug: PlugWriter,
  config: CycleConfig,
  deps: CycleCommandDeps,
  options: CycleCliOptions,
  json: boolean,
): Promise<boolean> {
  if (!options.force) return false;

  const target = config.wrongBoxTargetHost;
  if (!target) {
    // WYZR-20/WYZR-28: unreachable in practice — `suspectBox.host` (the
    // source of `wrongBoxTargetHost`) is a REQUIRED value in any config
    // src/config.ts's loadWyzrConfig() actually returns, so this branch
    // cannot be reached through the real CLI. Kept because the TYPE still
    // allows `undefined` (a test can hand this function a hand-built
    // CycleConfig with it unset), and a defensive Usage error naming the
    // real config key beats a silent confirmation with nothing to confirm.
    throw new CliError(
      `Usage: ${FORCE_FLAG} requires "suspectBox.host" to be configured in config.json, so the confirmation can ` +
        "name the target.",
      ExitCode.Usage,
    );
  }

  // D4: "the FULL evidence trail and verdict printed BEFORE acting" — this
  // preview is always run UNFORCED, so what it shows is the true gate
  // verdict, not a forced "proceed" glossing over it.
  const preview = await runCycleDryRun(plug, buildRunnerDeps(config, deps, false));
  if (json) {
    printJson(toCycleJson(preview));
  } else {
    printHuman(formatCycleHuman(preview));
  }

  if (options.nonInteractiveConfirmTarget !== undefined) {
    if (options.nonInteractiveConfirmTarget !== target) {
      throw new CliError(
        `Usage: --force-non-interactive-confirm-target did not match the configured target ("${target}") ` +
          "exactly — refusing.",
        ExitCode.Usage,
      );
    }
    return true;
  }

  const typed = await deps.confirm(target);
  if (typed === null || typed !== target) {
    throw new CliError(
      `Usage: ${FORCE_FLAG} requires typing the exact configured target host name at the interactive ` +
        "confirmation, or --force-non-interactive-confirm-target=<target> in a non-interactive context — " +
        "neither was satisfied.",
      ExitCode.Usage,
    );
  }
  return true;
}

/**
 * The one function src/cli.ts calls. Never throws for a refusal, `stranded`,
 * or any recovery-verdict outcome — those are all OUTCOME codes (see
 * src/errors.ts) — so this prints the normal evidence-trail payload and
 * RETURNS the code, the same discipline as src/cli-wedge.ts's
 * runWedgeStatus()/src/cli-recovery.ts's runRecoveryStatus(). Only a
 * genuine usage error (no device given, `--force` without its
 * confirmation, `--force` without a configured target) or a transport/auth
 * failure throws, mapped by src/cli.ts's existing error boundary.
 */
export async function runCycleCommand(
  deps: CycleCommandDeps,
  deviceQuery: string,
  json: boolean,
  options: CycleCliOptions,
): Promise<number> {
  const config = deps.loadConfig();
  const credentials = await deps.loadCredentials();
  const transport = deps.createTransport();
  const session = new WyzeAuthSession({ transport, credentials });
  await session.login();
  const devices = projectDeviceList(await session.getObjectList());
  const resolved = resolveDevice(devices, deviceQuery);
  const plug = new RealCyclePlugTransport(session, resolved);

  const forced = await resolveForced(plug, config, deps, options, json);
  const runnerDeps = buildRunnerDeps(config, deps, forced);

  const result: CycleResult = options.dryRun
    ? await runCycleDryRun(plug, runnerDeps)
    : await runCycleLive(plug, runnerDeps);

  if (json) {
    printJson(toCycleJson(result));
  } else {
    printHuman(formatCycleHuman(result));
  }
  return cycleOutcomeExitCode(result.outcome);
}
