// The I/O layer for `wyzr doctor` (WYZR-29): gathers every observation
// src/doctor.ts's pure `evaluateDoctorVerdict()` needs — config, credentials,
// a login attempt, the account's own device list, each configured plug's
// resolvability/readability, the outside instruments, and the wrong-box
// guard's verdict — through real or injected boundaries, and hands the
// decided per-check outcomes to the pure engine. Same
// pure-engine/impure-runner split as src/wedge-runner.ts/src/recovery-runner.ts.
//
// NEVER THROWS FOR A DIAGNOSTIC OUTCOME. Every other command in this repo
// that reads config (`wyzr wedge status`/`recovery status`/`cycle`) treats
// a broken config or missing credentials as a hard refusal, because those
// commands need a WORKING config to do their one job. This command's whole
// job is to REPORT on that state, so `loadConfig()`/`loadCredentials()`
// failing is not a usage error here — it is exactly the finding this
// command exists to surface. Only src/cli-doctor.ts's own usage-level
// argument parsing (there is none beyond `--json`) would ever throw.
//
// See src/doctor.ts's top comment for the "not-configured propagates as
// itself, fail propagates as could-not-look" rule `blockedByPrerequisite()`
// implements — every "blocked" branch below calls it rather than
// re-deciding the same question ad hoc per check.

import { CliError, ExitCode } from "./errors.ts";
import { loadWyzrConfig, type WyzrConfig } from "./config.ts";
import { loadCredentials, type Credentials } from "./credentials.ts";
import { WyzeAuthSession } from "./auth-session.ts";
import type { WyzeTransport } from "./transport.ts";
import { RealWyzeTransport } from "./transport-http.ts";
import { projectDeviceList, type DeviceRecord } from "./devices.ts";
import { RealCyclePlugTransport, type PlugReader } from "./cycle-plug.ts";
import { checkPlugReadable, isPlugResolvable } from "./doctor-plug.ts";
import { RealWrongBoxIdentityProbe, runWrongBoxGuard, type WrongBoxIdentityProbe } from "./cycle-wrong-box.ts";
import { RealWedgeProbes } from "./wedge-probes-real.ts";
import type { WedgeProbes } from "./wedge-probes.ts";
import { GITHUB_INSTRUMENT_NAME, JIRA_INSTRUMENT_NAME } from "./wedge-config.ts";
import type { CheckOutcome } from "./recovery.ts";
import {
  blockedByPrerequisite,
  evaluateDoctorVerdict,
  type DoctorCloudCheck,
  type DoctorConfigCheck,
  type DoctorCredentialsCheck,
  type DoctorInstrumentCheck,
  type DoctorPlugCheck,
  type DoctorResult,
} from "./doctor.ts";

export interface DoctorRunnerDeps {
  loadConfig: () => WyzrConfig;
  loadCredentials: () => Promise<Credentials>;
  createTransport: () => WyzeTransport;
  createWedgeProbes: () => WedgeProbes;
  createIdentityProbe: () => WrongBoxIdentityProbe;
}

export const defaultDoctorRunnerDeps: DoctorRunnerDeps = {
  loadConfig: () => loadWyzrConfig(),
  loadCredentials: () => loadCredentials(),
  createTransport: () => new RealWyzeTransport(),
  createWedgeProbes: () => new RealWedgeProbes(),
  createIdentityProbe: () => new RealWrongBoxIdentityProbe(),
};

/** Static — see src/doctor.ts's `DoctorInput.unproven` doc comment for why
 * this is prose about STRUCTURAL properties of the product, not data this
 * particular run observed, and therefore does not need to be computed per
 * run. Every claim below is checked against what this run of the doctor
 * ACTUALLY establishes elsewhere in this file (composition of already-
 * proven primitives, never a claim that this exact composition has itself
 * been proven) — see the PR body for the honesty-split mapping. */
export const DOCTOR_UNPROVEN_NOTES: readonly string[] = [
  "This command's own composition — config, then credentials, then a login attempt, then a plug read, then the " +
    "wrong-box guard, wired together exactly this way — has never been exercised against a real Wyze account by " +
    "anyone. No agent can ever run wyzr for real: it is forbidden to install on the fleet box wyzr protects. The " +
    "only way this composition is ever exercised for real is a human executor running it on the manager box — see " +
    "README's capture format for how to record that run so it becomes part of this repo's own provenance trail.",
  "The plug READ primitives this command composes (login, the auth envelope decode, the device-host request body, " +
    "get_property_list's field names, and P3/P5 decoding) were proven end-to-end against a real account on " +
    "2026-09-11 (`devices list`/`plug status` — exit 0, matching an earlier hand measurement mac-for-mac). This " +
    "command's OWN use of those primitives is new composition, not a new measurement of the primitives themselves.",
  "This command holds no PlugWriter anywhere in its dependency graph (see test/unit/doctor-imports.test.ts and " +
    "test/unit/doctor-no-write.test.ts). The write path (`plug on`/`plug off`, and the power cycle they compose " +
    "into) has never been exercised by this product, by anyone, ever, and this command cannot exercise it even by " +
    "accident.",
  "The wrong-box guard's identity-resolution mechanism (DNS/hosts-file lookup, local network-interface " +
    "enumeration) is unit-tested against fakes and hand-built address lists only in this repo's own test suite — " +
    "its behavior on the machine actually running this command is real evidence only for the specific run an " +
    "executor captured, never for this repo's test suite having exercised it.",
];

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configCheckFromError(err: unknown): DoctorConfigCheck {
  const note = errorMessageOf(err);
  if (err instanceof CliError && err.exitCode === ExitCode.ConfigInvalid && err.reason === "config_missing") {
    return { outcome: "not-configured", note, optionalSections: {} };
  }
  // Any other CliError (including the rare ExitCode.CredentialsInvalid a
  // missing HOME/XDG_CONFIG_HOME throws before this module's own path is
  // even known — see src/credentials.ts's wyzrConfigDir() doc comment) or
  // any non-CliError throw is a genuine, existing problem — "fail," not
  // "not-configured."
  return { outcome: "fail", note, optionalSections: {} };
}

function credentialsCheckFromError(err: unknown): DoctorCredentialsCheck {
  const note = errorMessageOf(err);
  if (err instanceof CliError && err.exitCode === ExitCode.CredentialsInvalid && err.reason === "credentials_missing") {
    return { outcome: "not-configured", note };
  }
  return { outcome: "fail", note };
}

function optionalSectionsOf(config: WyzrConfig): Record<string, boolean> {
  return {
    tunnelPing: config.wedge.tunnelPing !== undefined,
    jira: config.wedge.jira !== undefined,
    github: config.wedge.github !== undefined,
    controlPlane: config.wedge.controlPlane !== undefined,
    "recovery.daemon": config.recovery.daemon !== undefined,
    "recovery.fleetAudit": config.recovery.fleet !== undefined,
    "cycle.handRestoreCommand": config.cycle.handRestoreCommand !== undefined,
  };
}

type DeviceListResult = { readonly devices: readonly DeviceRecord[] } | { readonly errorMessage: string };

interface PlugTargetIdentity {
  readonly mac: string;
  readonly model: string;
  readonly name: string;
}

/** The caller's own guarantee (never re-checked here, since re-checking it
 * would only add an untestable-in-practice branch — see the review note
 * this replaced): a session and a device-list attempt exist whenever, and
 * only whenever, the cloud (login) check itself is "pass". `runDoctorCheck()`
 * below is the only caller and maintains this invariant directly — it
 * computes `deviceList` immediately after a successful login, before
 * calling this function at all. */
interface AuthenticatedCloudState {
  readonly session: WyzeAuthSession;
  readonly deviceList: DeviceListResult;
}

async function checkOnePlug(
  label: "fleetPlug" | "safePlug",
  configOutcome: CheckOutcome,
  target: PlugTargetIdentity | undefined,
  cloudOutcome: CheckOutcome,
  authenticated: AuthenticatedCloudState | undefined,
): Promise<DoctorPlugCheck> {
  if (configOutcome !== "pass" || !target) {
    const blocked = blockedByPrerequisite(configOutcome);
    const note = `blocked — the config check is "${configOutcome}", so this plug's configured identity is unknown`;
    return { label, mac: null, model: null, name: null, resolvable: blocked, resolvableNote: note, readable: blocked, readableNote: note };
  }

  let resolvable: CheckOutcome;
  let resolvableNote: string | null;
  if (cloudOutcome !== "pass" || !authenticated) {
    resolvable = blockedByPrerequisite(cloudOutcome);
    resolvableNote = `blocked — the cloud (login) check is "${cloudOutcome}", so the account's device list was never fetched`;
  } else if ("errorMessage" in authenticated.deviceList) {
    resolvable = "could-not-look";
    resolvableNote = authenticated.deviceList.errorMessage;
  } else {
    const found = isPlugResolvable(authenticated.deviceList.devices, target.mac);
    resolvable = found ? "pass" : "fail";
    resolvableNote = found
      ? "this mac was found in the account's own device list"
      : "this mac was NOT found in the account's own device list";
  }

  let readable: CheckOutcome;
  let readableNote: string | null;
  if (cloudOutcome !== "pass" || !authenticated) {
    readable = blockedByPrerequisite(cloudOutcome);
    readableNote = `blocked — the cloud (login) check is "${cloudOutcome}", so there is no authenticated session to read with`;
  } else {
    const reader: PlugReader = new RealCyclePlugTransport(authenticated.session, target);
    const result = await checkPlugReadable(reader);
    readable = result.outcome;
    readableNote = result.note;
  }

  return { label, mac: target.mac, model: target.model, name: target.name, resolvable, resolvableNote, readable, readableNote };
}

async function checkInstruments(
  configOutcome: CheckOutcome,
  config: WyzrConfig | undefined,
  wedgeProbes: WedgeProbes,
): Promise<DoctorInstrumentCheck[]> {
  if (configOutcome !== "pass" || !config) {
    const blocked = blockedByPrerequisite(configOutcome);
    const note = `blocked — the config check is "${configOutcome}"`;
    return [
      { name: JIRA_INSTRUMENT_NAME, outcome: blocked, note },
      { name: GITHUB_INSTRUMENT_NAME, outcome: blocked, note },
    ];
  }

  const results: DoctorInstrumentCheck[] = [];

  if (!config.wedge.jira) {
    results.push({ name: JIRA_INSTRUMENT_NAME, outcome: "not-configured", note: null });
  } else {
    const reading = await wedgeProbes.checkJiraActivity(config.wedge.jira);
    results.push({
      name: JIRA_INSTRUMENT_NAME,
      outcome: reading.outcome === "observed" ? "pass" : "could-not-look",
      note: reading.outcome === "observed" ? (reading.lastSeenAt !== null ? `last activity ${new Date(reading.lastSeenAt).toISOString()}` : null) : reading.note,
    });
  }

  if (!config.wedge.github) {
    results.push({ name: GITHUB_INSTRUMENT_NAME, outcome: "not-configured", note: null });
  } else {
    const reading = await wedgeProbes.checkGitHubActivity(config.wedge.github);
    results.push({
      name: GITHUB_INSTRUMENT_NAME,
      outcome: reading.outcome === "observed" ? "pass" : "could-not-look",
      note: reading.outcome === "observed" ? (reading.lastSeenAt !== null ? `last activity ${new Date(reading.lastSeenAt).toISOString()}` : null) : reading.note,
    });
  }

  return results;
}

/** The one function src/cli-doctor.ts calls. Never throws for a diagnostic
 * finding — see this module's own top comment; the returned `DoctorResult`
 * IS the outcome, whatever it is. */
export async function runDoctorCheck(deps: DoctorRunnerDeps = defaultDoctorRunnerDeps): Promise<DoctorResult> {
  let config: DoctorConfigCheck;
  let configValue: WyzrConfig | undefined;
  try {
    configValue = deps.loadConfig();
    config = { outcome: "pass", note: null, optionalSections: optionalSectionsOf(configValue) };
  } catch (err) {
    config = configCheckFromError(err);
  }

  let credentials: DoctorCredentialsCheck;
  let credentialsValue: Credentials | undefined;
  try {
    credentialsValue = await deps.loadCredentials();
    credentials = { outcome: "pass", note: null };
  } catch (err) {
    credentials = credentialsCheckFromError(err);
  }

  let cloud: DoctorCloudCheck;
  let session: WyzeAuthSession | undefined;
  if (credentials.outcome !== "pass" || !credentialsValue) {
    cloud = { outcome: blockedByPrerequisite(credentials.outcome), note: `blocked — the credentials check is "${credentials.outcome}"` };
  } else {
    const transport = deps.createTransport();
    const attemptSession = new WyzeAuthSession({ transport, credentials: credentialsValue });
    try {
      await attemptSession.login();
      cloud = { outcome: "pass", note: null };
      session = attemptSession;
    } catch (cause) {
      // Relayed VERBATIM — this command never diagnoses WHY a login
      // attempt failed (the ticket's rule 2: errorCode 1000 alone has at
      // least three indistinguishable causes). It reports only that the
      // attempt did not succeed, in the thrown error's own words.
      cloud = { outcome: "fail", note: errorMessageOf(cause) };
    }
  }

  let authenticated: AuthenticatedCloudState | undefined;
  if (cloud.outcome === "pass" && session) {
    let deviceList: DeviceListResult;
    try {
      const raw = await session.getObjectList();
      deviceList = { devices: projectDeviceList(raw) };
    } catch (cause) {
      deviceList = { errorMessage: errorMessageOf(cause) };
    }
    authenticated = { session, deviceList };
  }

  const fleetPlug = await checkOnePlug("fleetPlug", config.outcome, configValue?.fleetPlug, cloud.outcome, authenticated);
  const safePlug = await checkOnePlug("safePlug", config.outcome, configValue?.safePlug, cloud.outcome, authenticated);

  const instruments = await checkInstruments(config.outcome, configValue, deps.createWedgeProbes());

  const configuredTarget = config.outcome === "pass" && configValue ? configValue.cycle.wrongBoxTargetHost : undefined;
  const guardResult = await runWrongBoxGuard(configuredTarget, deps.createIdentityProbe());
  const wrongBoxGuardBlockedByMissingConfig = config.outcome === "not-configured";

  return evaluateDoctorVerdict({
    config,
    credentials,
    cloud,
    fleetPlug,
    safePlug,
    instruments,
    wrongBoxGuard: guardResult,
    wrongBoxGuardBlockedByMissingConfig,
    unproven: DOCTOR_UNPROVEN_NOTES,
  });
}
