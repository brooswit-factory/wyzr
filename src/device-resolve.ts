// Resolves a `<device>` CLI argument (mac or human-readable name) against
// the existing `devices list` projection (src/devices.ts) — for WYZR-13's
// `wyzr plug status|on|off`. Implements the ticket's decision (C) exactly:
//
// - Match `mac` case-insensitively, EXACT only. Match `name`
//   case-insensitively, EXACT only. No prefix, fuzzy, or substring matching
//   anywhere — a near-match is a not-found, not a guess.
// - Two or more devices matching -> ambiguous_device, and the error lists
//   every match (mac, model, name) so the operator can retry unambiguously.
//   Never picks one.
// - An argument that matches one device's `mac` AND a different device's
//   `name` is AMBIGUOUS too, not a mac-wins precedence — matches are
//   collected by DEVICE, not by which field matched, so this case falls out
//   of the same "more than one match" check below without special-casing it.
// - Zero matches -> not_found.
// - A device that resolves but whose `mac` or `model` is `null` (the
//   projection's partial-row case) cannot be addressed by a property call ->
//   a clear error naming which field was missing. Never sends a request
//   with a null field in it.

import type { DeviceRecord } from "./devices.ts";
import { CliError, ExitCode } from "./errors.ts";

/** A device with both identifiers present — the only shape a property call
 * (`get_property_list`/`set_property`) can be built from. */
export interface ResolvedDevice {
  mac: string;
  model: string;
  name: string;
}

function deviceNotFoundError(query: string): CliError {
  return new CliError(
    `No device matched "${query}" by exact mac or exact name (case-insensitive; no prefix, fuzzy, or ` +
      'substring matching). Run "wyzr devices list" to see what is on the account.',
    ExitCode.NotFound,
    "device_not_found",
  );
}

function describeMatch(device: DeviceRecord): string {
  return `mac=${device.mac ?? "(missing)"} model=${device.model ?? "(missing)"} name="${device.name}"`;
}

function deviceAmbiguousError(query: string, matches: DeviceRecord[]): CliError {
  return new CliError(
    `"${query}" matched more than one device: ${matches.map(describeMatch).join("; ")}. ` +
      "wyzr never guesses between matches — retry with a value (mac or name) that names exactly one device.",
    ExitCode.AmbiguousDevice,
    "device_ambiguous",
  );
}

/** No numbered exit code was assigned by the ticket for this specific case
 * (a device that resolved unambiguously but has a `null` mac or model, from
 * src/devices.ts's own partial-row-on-malformed-data policy) — decision (B)
 * only names 8/9/10. Reusing `not_found` (the device cannot be acted on any
 * more than a nonexistent one could) with a distinct `reason` keeps this
 * distinguishable from a true zero-match not-found without touching
 * 0-7 or inventing an unassigned number. Flagged on the ticket, not silently
 * decided — see the PR body. */
function deviceMissingIdentifierError(device: DeviceRecord, field: "mac" | "model"): CliError {
  return new CliError(
    `Device "${device.name}" matched, but its ${field} was missing or malformed in devices list's own ` +
      `projection (see "wyzr devices list --json" for the partial row), so it cannot be addressed by a ` +
      "property call. Refusing to send a request with a null field in it.",
    ExitCode.NotFound,
    `device_missing_${field}`,
  );
}

/**
 * Resolves `query` (a mac or a name) to exactly one addressable device, or
 * throws one of the CliErrors above. Never guesses.
 */
export function resolveDevice(devices: DeviceRecord[], query: string): ResolvedDevice {
  const needle = query.toLowerCase();
  const matches = devices.filter(
    (device) => (device.mac !== null && device.mac.toLowerCase() === needle) || device.name.toLowerCase() === needle,
  );

  if (matches.length === 0) {
    throw deviceNotFoundError(query);
  }
  if (matches.length > 1) {
    throw deviceAmbiguousError(query, matches);
  }

  const device = matches[0]!;
  if (device.mac === null) {
    throw deviceMissingIdentifierError(device, "mac");
  }
  if (device.model === null) {
    throw deviceMissingIdentifierError(device, "model");
  }
  return { mac: device.mac, model: device.model, name: device.name };
}
