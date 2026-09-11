// THE single configuration surface (WYZR-20/WYZR-28). Loads, validates, and
// returns a `WyzrConfig` from `<config base>/wyzr/config.json`, resolved by
// the exact same XDG rule src/credentials.ts already implements
// (`wyzrConfigDir()`, reused rather than reimplemented — see that module's
// own comment). Mirrors src/credentials.ts's own discipline throughout:
// refuses an over-permissive directory OR file (`mode & 0o077`, checked
// outer-to-inner), refuses an unknown top-level field, refuses a
// missing/mistyped required field, names the field but NEVER any part of a
// value in any error, and registers every secret with src/redact.ts before
// returning.
//
// RULING — ONE SURFACE, NOT TWO (ratified, see the ticket's own follow-up
// comment). This file becomes the SOLE runtime configuration source for the
// CLI: src/wedge-config.ts's, src/recovery-config.ts's, and
// src/cycle-config.ts's own `*FromEnv()` loaders are gone, and
// `defaultWedgeStatusDeps`/`defaultRecoveryStatusDeps`/`defaultCycleCommandDeps`
// (src/cli-wedge.ts/src/cli-recovery.ts/src/cli-cycle.ts) all resolve to
// `loadWyzrConfig()` below. Why this matters more than "two sources can
// disagree": `wedge-config` used to carry the suspect box while
// `cycle-config` carried the target plug — a file/env disagreement between
// them would not just produce a confusing config, it would produce a gate
// that proves box A is wedged and a verb that cuts power to box B, WITH NO
// ERROR ANYWHERE. `test/unit/config.test.ts`'s "no WYZR_* env var influences
// the loaded config" test is the pin on exactly that: it sets a plausible
// `WYZR_WEDGE_SSH_HOST`-shaped variable, loads a config from a fixture file,
// and asserts the env value never appears in the result.
//
// RULING — THE SUSPECT BOX'S HOST IS THE WRONG-BOX GUARD'S TARGET, ONE
// FIELD, NOT TWO. The old env loaders kept `WYZR_WEDGE_SSH_HOST` (the
// suspect box's ssh direct path, read by `wyzr wedge status`/`recovery
// status`) and `WYZR_CYCLE_WRONG_BOX_TARGET_HOST` (the wrong-box guard's
// target, read only by `wyzr cycle`) as two independently-settable values
// that HAPPENED to usually agree. This config makes them the SAME value —
// `suspectBox.host` below feeds both `WedgeConfig.ssh`/`RecoveryConfig`'s
// reused-ssh-host probes AND `CycleConfig.wrongBoxTargetHost` — for the
// identical reason src/recovery-config.ts's own (removed) top comment
// already gave for reusing `ssh.host` rather than introducing a second host
// var: there is no legitimate reason for "the box wyzr wedge status
// watches" and "the box the wrong-box guard refuses to cut power to" to
// ever be configured differently, and a second field that COULD diverge is
// exactly the two-surfaces hazard this whole ticket exists to close.
// Consequence: `suspectBox.host` is now REQUIRED (the ticket's own required
// list names both "the suspect box's identity/ssh target" and "the
// wrong-box guard's target host" — they are the same requirement stated
// from two callers' points of view), so — unlike the old env loader, where
// ssh could be left unconfigured independently of everything else —
// `CycleConfig.wrongBoxTargetHost` and `RecoveryConfig.uptime` are now ALWAYS
// populated in any config that loads at all. `daemon`/`fleet` still
// independently gate on their own required-together pairs (unit+scope,
// processMatch+expectedFlags), unchanged from the old loader's behavior.
//
// RULING — MALFORMED VS. ABSENT, FOR EVERY DEFAULT-PERMITTED NUMERIC FIELD.
// The ticket permits a default ONLY for timeouts, quiet thresholds, the
// local-connectivity target, and the cycle timing bounds. The removed
// `positiveIntMs()` (src/wedge-config.ts, WYZR-16) fell back to the default
// for BOTH "value absent" and "value present but malformed" — defensible for
// an env var (every env var is a string; "not-a-number" is a plausible typo
// a provisional loader could shrug off). A follow-up review comment on this
// ticket sharpened this exactly: in a config FILE, a present-but-malformed
// value is a PARTIAL LOAD that leaves an instrument quietly mis-tuned —
// precisely the failure this ticket forbids. Decision, stated once here:
// `optionalPositiveNumberField()` below returns the documented default ONLY
// when the field is ABSENT (undefined/null/missing key); a field that IS
// present but is not a finite positive number is a REFUSAL naming the field,
// never a silent substitution. This is the config-file-wide numeric rule —
// no per-field exception.
//
// RULING — AN INVALID DAEMON SCOPE REFUSES, IT DOES NOT VANISH. The removed
// env loader's `parseDaemonScope()` treated anything other than exactly
// `"user"`/`"system"` (including a typo) as "absent", silently leaving the
// whole daemon check unconfigured. The same follow-up comment named this
// directly: "a typo'd scope in a file should almost certainly REFUSE and
// name the value, not vanish." `requireDaemonScope()` below does exactly
// that when the `recovery.daemon` SECTION is present at all — `scope` is one
// of that section's required keys, so a present-but-invalid value is the
// same "half-filled section" refusal every other required-key violation in
// this file produces, not a special case.
//
// SECRETS VS. IDENTIFIERS. `jira.authHeader` and `github.token` are
// CREDENTIALS: registered with `registerSecret()` before this loader
// returns, exactly like src/credentials.ts's own `loadCredentials()`, so no
// caller can print one before it is protected. Hostnames, plug names, macs,
// and addresses are DELIBERATELY NEVER registered — the epic ruled these
// identifiers must stay legible in the diagnostics an operator reads on
// their own screen (a mistaken refusal with its addresses scrubbed is an
// undiagnosable refusal). That ruling is about the WEDGE/RECOVERY/CYCLE
// diagnostic output this config feeds, which is unrelated code this ticket
// does not touch — it does NOT relax this module's OWN refusal discipline:
// every CliError thrown below names only field/section names and the config
// path, never an actual configured value (see "no error path echoes config
// contents" in every helper below).

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError, ExitCode } from "./errors.ts";
import { registerSecret } from "./redact.ts";
import { type CredentialsEnv, wyzrConfigDir } from "./credentials.ts";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_LOCAL_CONNECTIVITY_CONFIG,
  DEFAULT_LOCAL_CONNECTIVITY_TARGET,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_QUIET_THRESHOLD_MS,
  GITHUB_INSTRUMENT_NAME,
  JIRA_INSTRUMENT_NAME,
  MANAGER_INTERNET_DEPENDENCY,
  SSH_DIRECT_PATH_NAME,
  TUNNEL_PING_DIRECT_PATH_NAME,
  type WedgeConfig,
} from "./wedge-config.ts";
import type {
  ControlPlaneConfig,
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
} from "./wedge-probes.ts";
import type { RecoveryConfig } from "./recovery-config.ts";
import type { DaemonProbeConfig, DaemonScope, FleetAuditConfig, UptimeProbeConfig } from "./recovery-probes.ts";
import { DEFAULT_CYCLE_TIMING, type CycleConfig, type CycleTimingConfig } from "./cycle-config.ts";

/** The env vars this loader reads for XDG resolution ONLY — the same
 * narrow shape src/credentials.ts's `CredentialsEnv` already declares.
 * Reused directly rather than re-declared (this module never reads a
 * `WYZR_*` var — see this module's top comment's "one surface" ruling). */
export type WyzrConfigEnv = CredentialsEnv;

const systemEnv: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>;

export function wyzrConfigPath(env: WyzrConfigEnv = systemEnv): string {
  return join(wyzrConfigDir(env), "config.json");
}

function configError(message: string, reason: string): CliError {
  return new CliError(message, ExitCode.ConfigInvalid, reason);
}

/** `mode & 0o077` — any of the low 6 bits (group or other: rwx) set. Same
 * rule as src/credentials.ts's own `isOverPermissive()`. */
function isOverPermissive(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function checkMode(path: string, kind: "directory" | "file", fixMode: string): void {
  const info = statSync(path);
  if (isOverPermissive(info.mode)) {
    const octal = (info.mode & 0o777).toString(8).padStart(3, "0");
    throw configError(
      `Config ${kind} ${path} is readable by group or others (mode ${octal}). ` +
        `Refusing to load config. Fix with: chmod ${fixMode} ${path}`,
      kind === "directory" ? "config_dir_mode" : "config_file_mode",
    );
  }
}

function requireObject(parsed: unknown, path: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError(`Config file at ${path} must contain a single JSON object.`, "config_shape");
  }
  return parsed as Record<string, unknown>;
}

const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  "suspectBox",
  "tunnelPing",
  "jira",
  "github",
  "localConnectivity",
  "controlPlane",
  "recovery",
  "cycle",
  "fleetPlug",
  "safePlug",
]);

function requireObjectField(obj: Record<string, unknown>, field: string, path: string): Record<string, unknown> {
  const value = obj[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError(
      `Config file at ${path} is missing required section "${field}" (must be a JSON object).`,
      "config_field_missing",
    );
  }
  return value as Record<string, unknown>;
}

/** `undefined` when the section is entirely absent (a deliberate operator
 * choice — the caller reports the matching instrument/check as
 * UNCONFIGURED). Throws when the key IS present but is not an object at
 * all (wrong shape) — a section that is present must be an object before
 * its own keys can even be checked for completeness. */
function optionalObjectField(obj: Record<string, unknown>, field: string, path: string): Record<string, unknown> | undefined {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return undefined;
  const value = obj[field];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError(`Config file at ${path} has section "${field}" that must be a JSON object.`, "config_field_invalid");
  }
  return value as Record<string, unknown>;
}

function requireStringField(obj: Record<string, unknown>, sectionLabel: string, field: string, path: string): string {
  const key = sectionLabel ? `${sectionLabel}.${field}` : field;
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
    throw configError(`Config file at ${path} is missing required value "${key}".`, "config_field_missing");
  }
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw configError(`Config file at ${path} has value "${key}" that must be a non-empty string.`, "config_field_invalid");
  }
  return value;
}

/** An empty string counts as absent — same convention as
 * src/credentials.ts's `optionalStringField()` (its own comment explains
 * why: a naive `!== undefined` reading of `""` as "configured" produces a
 * confusing failure downstream instead of this module's own clear
 * "not configured" contract). */
function optionalStringField(obj: Record<string, unknown>, sectionLabel: string, field: string, path: string): string | undefined {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return undefined;
  const value = obj[field];
  const key = sectionLabel ? `${sectionLabel}.${field}` : field;
  if (typeof value !== "string") {
    throw configError(`Config file at ${path} has value "${key}" that must be a string.`, "config_field_invalid");
  }
  return value.length === 0 ? undefined : value;
}

/**
 * The config-file-wide numeric rule (see this module's top comment):
 * absent -> `fallback`; present but not a finite positive number ->
 * REFUSE naming the field. Never silently substitutes the default for a
 * malformed present value.
 */
function optionalPositiveNumberField(
  obj: Record<string, unknown>,
  sectionLabel: string,
  field: string,
  path: string,
  fallback: number,
): number {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return fallback;
  const value = obj[field];
  const key = sectionLabel ? `${sectionLabel}.${field}` : field;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw configError(`Config file at ${path} has value "${key}" that must be a positive number.`, "config_field_invalid");
  }
  return value;
}

function requireStringArrayField(obj: Record<string, unknown>, sectionLabel: string, field: string, path: string): readonly string[] {
  const value = obj[field];
  const key = sectionLabel ? `${sectionLabel}.${field}` : field;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw configError(
      `Config file at ${path} is missing required value "${key}" (must be a non-empty array of non-empty strings).`,
      "config_field_missing",
    );
  }
  return value as string[];
}

/** `recovery.daemon.scope` must be exactly `"user"` or `"system"` when the
 * `daemon` section is present — see this module's top comment's "an
 * invalid daemon scope refuses, it does not vanish" ruling. Never falls
 * back to "unconfigured" the way the old env loader's `parseDaemonScope()`
 * did for a typo. */
function requireDaemonScope(obj: Record<string, unknown>, path: string): DaemonScope {
  const value = obj["scope"];
  if (value !== "user" && value !== "system") {
    throw configError(
      `Config file at ${path} has value "recovery.daemon.scope" that must be exactly "user" or "system".`,
      "config_field_invalid",
    );
  }
  return value;
}

// ---------------------------------------------------------------------
// Fleet plug / safe plug — structurally impossible to conflate (Deliverable 2)
// ---------------------------------------------------------------------

/** The fields either plug target carries. Unbranded on its own — never
 * returned to a caller in this shape; always wrapped as a `FleetPlugTarget`
 * or a `SafePlugTarget` below before this module hands it out. */
interface PlugTargetFields {
  readonly mac: string;
  readonly model: string;
  readonly name: string;
  /** THE SUB-DEVICE REQUIREMENT: relayed ground truth (not measured by
   * this repo) is that the fleet box's plug is a plain `Plug` (model
   * `WLPP1CFH`, itself a configuration VALUE — never hard-coded here) with
   * no `-SUB` children, while an `OutdoorPlug` (model `WLPPO`) DOES have
   * `-SUB` children, where the addressable switchable thing is a
   * SUB-DEVICE, not the device itself. `null` means "this plug target IS
   * the addressable device" (the fleet plug's ordinary case); a non-null
   * value names which sub-device is the actual switchable target (expected
   * for an `OutdoorPlug`-modeled safe plug, but this schema does not
   * enforce that coupling — the model string is an opaque configuration
   * value this module never branches on). That a sub-device is separately
   * addressable this way is RELAYED, not measured by this repo — stated
   * here rather than asserted as confirmed. */
  readonly subDeviceId: string | null;
}

const FLEET_PLUG_BRAND: unique symbol = Symbol("wyzr-config-fleet-plug");
const SAFE_PLUG_BRAND: unique symbol = Symbol("wyzr-config-safe-plug");

/**
 * The plug on the cord of the box the whole fleet runs on. Branded with a
 * MODULE-PRIVATE `unique symbol` — same technique, same reasoning, as
 * src/cycle-preconditions.ts's `PreconditionsClearedWitness` (see that
 * type's own comment): no code outside this module can even NAME the
 * brand property, so no other file can construct a value of this type
 * short of an explicit, visible `as unknown as FleetPlugTarget` lie a
 * reviewer would have to wave through. Only `loadWyzrConfig()` below ever
 * constructs one. This is what makes "a safe-plug-only operation
 * (a later task's write rehearsal) accidentally pointed at the fleet
 * plug" a COMPILE error rather than a runtime check someone can forget —
 * see test/unit/config.test.ts's `@ts-expect-error` pin.
 */
export interface FleetPlugTarget extends PlugTargetFields {
  readonly [FLEET_PLUG_BRAND]: true;
}

/**
 * The deliberately-chosen safe plug a LATER task will rehearse a real
 * write against. Same branding technique as `FleetPlugTarget` above, with
 * its OWN distinct module-private symbol — `FleetPlugTarget` and
 * `SafePlugTarget` are therefore two structurally unrelated types even
 * though they share every field name, and neither satisfies the other.
 */
export interface SafePlugTarget extends PlugTargetFields {
  readonly [SAFE_PLUG_BRAND]: true;
}

function parsePlugTargetFields(obj: Record<string, unknown>, sectionLabel: string, path: string): PlugTargetFields {
  const mac = requireStringField(obj, sectionLabel, "mac", path);
  const model = requireStringField(obj, sectionLabel, "model", path);
  const name = requireStringField(obj, sectionLabel, "name", path);
  const subDeviceId = optionalStringField(obj, sectionLabel, "subDeviceId", path) ?? null;
  return { mac, model, name, subDeviceId };
}

function parseFleetPlug(obj: Record<string, unknown>, path: string): FleetPlugTarget {
  const fields = parsePlugTargetFields(requireObjectField(obj, "fleetPlug", path), "fleetPlug", path);
  return { ...fields, [FLEET_PLUG_BRAND]: true };
}

function parseSafePlug(obj: Record<string, unknown>, path: string): SafePlugTarget {
  const fields = parsePlugTargetFields(requireObjectField(obj, "safePlug", path), "safePlug", path);
  return { ...fields, [SAFE_PLUG_BRAND]: true };
}

/** "The same device": an identical `mac`, UNLESS both `subDeviceId`s are
 * non-null and DIFFER (two sibling outlets under one physical device —
 * the one same-mac case that genuinely names two distinct switchable
 * things). Comparison is trim/lowercase-normalised, same
 * case/whitespace-insensitive rule this repo's src/cycle-wrong-box.ts
 * already uses for its own identity comparisons.
 *
 * REVIEW FINDING 1 (WYZR-28): the first version of this function compared
 * `subDeviceId` for EQUALITY, which let a PARENT/CHILD pair — `(mac, null)`
 * (the parent device itself, per `PlugTargetFields.subDeviceId`'s own
 * comment: "this plug target IS the addressable device") paired with
 * `(mac, "sub-1")` (one outlet inside that SAME device) — load without
 * refusing, on the theory that `null !== "sub-1"` means "different." That
 * is wrong: those two are not peers, one CONTAINS the other, and whether
 * writing P3 to the parent also affects its sub-devices is NOT something
 * this repo has measured. A rehearsal whose target might contain the
 * fleet box's own outlet is exactly the outcome this check exists to
 * prevent — so a parent/child pair refuses BECAUSE the containment
 * relationship is unmeasured, not because it is known to be dangerous.
 * Only two DISTINCT, non-null sub-device ids under the same mac (true
 * siblings, neither containing the other) are treated as different
 * devices; every other same-mac pairing (both null; one null, one not;
 * identical non-null ids) counts as the same device.
 *
 * WHAT THIS CANNOT SEE, stated explicitly per the ticket's own
 * requirement: two DIFFERENT mac addresses that happen to name the same
 * physical device (an operator data-entry duplicate), or a sub-device
 * relationship the config never expressed via `subDeviceId` at all — this
 * is a syntactic equality check over configured identifiers, not device
 * introspection. */
function normalizeIdentityField(s: string | null): string | null {
  return s === null ? null : s.trim().toLowerCase();
}

function samePlugIdentity(a: PlugTargetFields, b: PlugTargetFields): boolean {
  if (normalizeIdentityField(a.mac) !== normalizeIdentityField(b.mac)) return false;
  const subA = normalizeIdentityField(a.subDeviceId);
  const subB = normalizeIdentityField(b.subDeviceId);
  const distinctSiblings = subA !== null && subB !== null && subA !== subB;
  return !distinctSiblings;
}

function refuseIfPlugsConflate(fleetPlug: FleetPlugTarget, safePlug: SafePlugTarget, path: string): void {
  if (samePlugIdentity(fleetPlug, safePlug)) {
    throw configError(
      `Config file at ${path} configures "fleetPlug" and "safePlug" as the SAME device (identical mac, and not ` +
        "two distinct, non-null sub-device ids, after normalisation) — refusing: a safe-plug write rehearsal must " +
        "never be able to reach the fleet plug. Field names only — see this module's own samePlugIdentity() " +
        'comment for exactly what "the same device" means here and what this check cannot see.',
      "config_plug_conflation",
    );
  }
}

// ---------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------

function parseSuspectBox(obj: Record<string, unknown>, path: string): { host: string; timeoutMs: number; connectTimeoutMs: number } {
  const section = requireObjectField(obj, "suspectBox", path);
  const host = requireStringField(section, "suspectBox", "host", path);
  const timeoutMs = optionalPositiveNumberField(section, "suspectBox", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  const connectTimeoutMs = optionalPositiveNumberField(section, "suspectBox", "connectTimeoutMs", path, DEFAULT_CONNECT_TIMEOUT_MS);
  return { host, timeoutMs, connectTimeoutMs };
}

function parseTunnelPing(obj: Record<string, unknown>, path: string): DirectPathConfig | undefined {
  const section = optionalObjectField(obj, "tunnelPing", path);
  if (!section) return undefined;
  const host = requireStringField(section, "tunnelPing", "host", path);
  const timeoutMs = optionalPositiveNumberField(section, "tunnelPing", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  const connectTimeoutMs = optionalPositiveNumberField(section, "tunnelPing", "connectTimeoutMs", path, DEFAULT_CONNECT_TIMEOUT_MS);
  return { name: TUNNEL_PING_DIRECT_PATH_NAME, host, timeoutMs, connectTimeoutMs };
}

function parseJira(obj: Record<string, unknown>, path: string): JiraInstrumentConfig | undefined {
  const section = optionalObjectField(obj, "jira", path);
  if (!section) return undefined;
  const baseUrl = requireStringField(section, "jira", "baseUrl", path);
  const authHeader = requireStringField(section, "jira", "authHeader", path);
  const projectKey = optionalStringField(section, "jira", "projectKey", path);
  const quietThresholdMs = optionalPositiveNumberField(section, "jira", "quietThresholdMs", path, DEFAULT_QUIET_THRESHOLD_MS);
  const timeoutMs = optionalPositiveNumberField(section, "jira", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return {
    name: JIRA_INSTRUMENT_NAME,
    baseUrl,
    projectKey,
    authHeader,
    dependsOn: [MANAGER_INTERNET_DEPENDENCY],
    quietThresholdMs,
    timeoutMs,
  };
}

function parseGitHub(obj: Record<string, unknown>, path: string): GitHubInstrumentConfig | undefined {
  const section = optionalObjectField(obj, "github", path);
  if (!section) return undefined;
  const owner = requireStringField(section, "github", "owner", path);
  const repo = optionalStringField(section, "github", "repo", path);
  const token = optionalStringField(section, "github", "token", path);
  const quietThresholdMs = optionalPositiveNumberField(section, "github", "quietThresholdMs", path, DEFAULT_QUIET_THRESHOLD_MS);
  const timeoutMs = optionalPositiveNumberField(section, "github", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return { name: GITHUB_INSTRUMENT_NAME, owner, repo, token, dependsOn: [MANAGER_INTERNET_DEPENDENCY], quietThresholdMs, timeoutMs };
}

function parseLocalConnectivity(obj: Record<string, unknown>, path: string): LocalConnectivityConfig {
  const section = optionalObjectField(obj, "localConnectivity", path);
  if (!section) return DEFAULT_LOCAL_CONNECTIVITY_CONFIG;
  const target = optionalStringField(section, "localConnectivity", "target", path) ?? DEFAULT_LOCAL_CONNECTIVITY_TARGET;
  const timeoutMs = optionalPositiveNumberField(section, "localConnectivity", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return { ...DEFAULT_LOCAL_CONNECTIVITY_CONFIG, target, timeoutMs };
}

function parseControlPlane(obj: Record<string, unknown>, path: string): ControlPlaneConfig | undefined {
  const section = optionalObjectField(obj, "controlPlane", path);
  if (!section) return undefined;
  const name = requireStringField(section, "controlPlane", "name", path);
  const timeoutMs = optionalPositiveNumberField(section, "controlPlane", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return { name, timeoutMs };
}

function parseDaemon(obj: Record<string, unknown>, sshHost: string, path: string): DaemonProbeConfig | undefined {
  const section = optionalObjectField(obj, "daemon", path);
  if (!section) return undefined;
  const unit = requireStringField(section, "recovery.daemon", "unit", path);
  const scope = requireDaemonScope(section, path);
  const timeoutMs = optionalPositiveNumberField(section, "recovery.daemon", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return { host: sshHost, unit, scope, timeoutMs };
}

function parseFleetAudit(obj: Record<string, unknown>, sshHost: string, path: string): FleetAuditConfig | undefined {
  const section = optionalObjectField(obj, "fleetAudit", path);
  if (!section) return undefined;
  const processMatch = requireStringField(section, "recovery.fleetAudit", "processMatch", path);
  const expectedFlags = requireStringArrayField(section, "recovery.fleetAudit", "expectedFlags", path);
  const timeoutMs = optionalPositiveNumberField(section, "recovery.fleetAudit", "timeoutMs", path, DEFAULT_PROBE_TIMEOUT_MS);
  return { host: sshHost, processMatch, expectedFlags, timeoutMs };
}

function parseCycleTiming(obj: Record<string, unknown> | undefined, path: string): CycleTimingConfig {
  if (!obj) return DEFAULT_CYCLE_TIMING;
  return {
    offToOnWaitMs: optionalPositiveNumberField(obj, "cycle.timing", "offToOnWaitMs", path, DEFAULT_CYCLE_TIMING.offToOnWaitMs),
    offReadbackPollIntervalMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "offReadbackPollIntervalMs",
      path,
      DEFAULT_CYCLE_TIMING.offReadbackPollIntervalMs,
    ),
    offReadbackBoundMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "offReadbackBoundMs",
      path,
      DEFAULT_CYCLE_TIMING.offReadbackBoundMs,
    ),
    restoreReadbackPollIntervalMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "restoreReadbackPollIntervalMs",
      path,
      DEFAULT_CYCLE_TIMING.restoreReadbackPollIntervalMs,
    ),
    restoreReadbackBoundMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "restoreReadbackBoundMs",
      path,
      DEFAULT_CYCLE_TIMING.restoreReadbackBoundMs,
    ),
    restorePollIntervalMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "restorePollIntervalMs",
      path,
      DEFAULT_CYCLE_TIMING.restorePollIntervalMs,
    ),
    restoreTimeoutMs: optionalPositiveNumberField(
      obj,
      "cycle.timing",
      "restoreTimeoutMs",
      path,
      DEFAULT_CYCLE_TIMING.restoreTimeoutMs,
    ),
  };
}

// ---------------------------------------------------------------------
// The aggregate shape and the loader
// ---------------------------------------------------------------------

/** The full, validated configuration this CLI reads — projections of it
 * (`.wedge`, `.recovery`, `.cycle`) are handed straight to
 * `defaultWedgeStatusDeps`/`defaultRecoveryStatusDeps`/`defaultCycleCommandDeps`
 * (src/cli-wedge.ts/src/cli-recovery.ts/src/cli-cycle.ts) unchanged — those
 * modules' own `WedgeConfig`/`RecoveryConfig`/`CycleConfig` types are not
 * widened or altered by this ticket. `.fleetPlug`/`.safePlug` are consumed
 * by no command in THIS ticket's scope — they exist for a later task's
 * write-rehearsal command to consume, structurally unable to confuse one
 * for the other (see `FleetPlugTarget`/`SafePlugTarget` above). */
export interface WyzrConfig {
  readonly wedge: WedgeConfig;
  readonly recovery: RecoveryConfig;
  readonly cycle: CycleConfig;
  readonly fleetPlug: FleetPlugTarget;
  readonly safePlug: SafePlugTarget;
}

/**
 * Load, validate, and return the ONE configuration surface from
 * `<config base>/wyzr/config.json`. Every failure — missing file, bad
 * mode, malformed JSON, wrong shape, missing/mistyped/incomplete section,
 * plug conflation — throws a `CliError` on `ExitCode.ConfigInvalid`. Never
 * reads a `WYZR_*` environment variable for anything — `env` here is used
 * ONLY to resolve which directory to look in (the same XDG rule
 * src/credentials.ts uses for credentials.json), exactly like that
 * module's own `env` parameter.
 */
export function loadWyzrConfig(env: WyzrConfigEnv = systemEnv): WyzrConfig {
  const dir = wyzrConfigDir(env);
  const path = wyzrConfigPath(env);

  try {
    accessSync(path, fsConstants.F_OK);
  } catch {
    throw configError(
      `No config file found at ${path}. Create it as JSON with (at least) the required sections: ` +
        '"suspectBox" (with a "host"), "fleetPlug", and "safePlug" — see docs/config.example.json for a ' +
        "complete, placeholder-only example of every required and optional section.",
      "config_missing",
    );
  }

  // Outer-to-inner, same order and reasoning as src/credentials.ts's own
  // checkMode() calls: a directory an attacker can write to can replace
  // the file entirely, so its mode matters independently of the file's own.
  checkMode(dir, "directory", "700");
  checkMode(path, "file", "600");

  const raw = readFileSync(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`Config file at ${path} is not valid JSON.`, "config_malformed");
  }

  const obj = requireObject(parsed, path);

  for (const field of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(field)) {
      throw configError(`Config file at ${path} has unknown top-level field "${field}".`, "config_unknown_field");
    }
  }

  const suspectBox = parseSuspectBox(obj, path);
  const tunnelPing = parseTunnelPing(obj, path);
  const jira = parseJira(obj, path);
  const github = parseGitHub(obj, path);
  const localConnectivity = parseLocalConnectivity(obj, path);
  const controlPlane = parseControlPlane(obj, path);

  const ssh: DirectPathConfig = {
    name: SSH_DIRECT_PATH_NAME,
    host: suspectBox.host,
    timeoutMs: suspectBox.timeoutMs,
    connectTimeoutMs: suspectBox.connectTimeoutMs,
  };

  const wedge: WedgeConfig = { jira, github, ssh, tunnelPing, localConnectivity, controlPlane };

  const recoverySection = optionalObjectField(obj, "recovery", path);
  const daemon = parseDaemon(recoverySection ?? {}, suspectBox.host, path);
  const fleet = parseFleetAudit(recoverySection ?? {}, suspectBox.host, path);
  const uptimeTimeoutMs = recoverySection
    ? optionalPositiveNumberField(recoverySection, "recovery", "uptimeTimeoutMs", path, suspectBox.timeoutMs)
    : suspectBox.timeoutMs;
  const uptime: UptimeProbeConfig = { host: suspectBox.host, timeoutMs: uptimeTimeoutMs };

  const recovery: RecoveryConfig = { jira, github, ssh, tunnelPing, localConnectivity, uptime, daemon, fleet };

  const cycleSection = optionalObjectField(obj, "cycle", path);
  const handRestoreCommand = cycleSection ? optionalStringField(cycleSection, "cycle", "handRestoreCommand", path) : undefined;
  const timing = parseCycleTiming(cycleSection ? optionalObjectField(cycleSection, "timing", path) : undefined, path);

  const cycle: CycleConfig = { gate: wedge, recovery, wrongBoxTargetHost: suspectBox.host, handRestoreCommand, timing };

  const fleetPlug = parseFleetPlug(obj, path);
  const safePlug = parseSafePlug(obj, path);
  refuseIfPlugsConflate(fleetPlug, safePlug, path);

  // Registered before this function returns — no call site downstream can
  // print a credential before it is protected. Hostnames/addresses/macs/
  // plug names are deliberately NOT registered — see this module's top
  // comment's "secrets vs. identifiers" ruling.
  registerSecret(jira?.authHeader);
  registerSecret(github?.token);

  return { wedge, recovery, cycle, fleetPlug, safePlug };
}
