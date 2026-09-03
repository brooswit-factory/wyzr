// Wires `wyzr plug status|on|off` together: WyzeAuthSession (login +
// getObjectList + getPropertyList + setProperty) + src/device-resolve.ts +
// src/plug.ts + src/output.ts. Same injectable-everything pattern as
// src/cli-devices.ts — every function here is fully exercisable against
// FakeWyzeTransport and fixture credentials, zero credentials file, zero
// network. src/cli.ts's dispatchPlug() is the only place that supplies
// RealWyzeTransport and loadCredentials().

import { WyzeAuthSession } from "./auth-session.ts";
import type { Credentials } from "./credentials.ts";
import { resolveDevice } from "./device-resolve.ts";
import { projectDeviceList } from "./devices.ts";
import { printHuman, printJson } from "./output.ts";
import {
  classifyWriteOutcome,
  formatPlugStatusHuman,
  formatPlugWriteHuman,
  PLUG_SCHEMA_VERSION,
  readPlugState,
  SINGLE_IMMEDIATE_READ,
  statusExitCode,
  writeResultExitCode,
  type PlugReading,
  type PlugStatusJson,
  type PlugWriteJson,
} from "./plug.ts";
import type { WyzeTransport } from "./transport.ts";

export interface PlugCommandDeps {
  transport: WyzeTransport;
  credentials: Credentials;
}

/** Shared by all three verbs: log in, list devices, resolve `<device>` to
 * exactly one addressable device. Never guesses — resolveDevice() throws
 * (ambiguous_device / not_found / the missing-mac-or-model case) before any
 * property call is ever made, so a write verb never sends a request built
 * from an ambiguous resolution. */
async function loginAndResolve(deps: PlugCommandDeps, deviceQuery: string) {
  const session = new WyzeAuthSession({ transport: deps.transport, credentials: deps.credentials });
  await session.login();
  const devices = projectDeviceList(await session.getObjectList());
  const resolved = resolveDevice(devices, deviceQuery);
  return { session, resolved };
}

/**
 * `--json` shape: PlugStatusJson (src/plug.ts) — see README's "--json
 * contract" section. Exit code: ExitCode.Ok only when BOTH P3 and P5 are
 * decodable (decision (E)); otherwise ExitCode.StateUnknown, printed as the
 * normal payload and returned, never thrown (decision (F2) — the read DID
 * succeed and produced an observation worth reporting, it just could not
 * decode both properties confidently).
 *
 * Deliberately NOT wrapped in try/catch: if `getPropertyList` itself throws
 * (transport/API/auth failure), that propagates UNCAUGHT as a real error —
 * nothing was observed at all here, unlike the write verbs' post-write
 * read-back, so this stays an error code (network/api_error/etc), never
 * folded into `state_unknown`. Per decision (F2): "a genuine transport
 * failure on `plug status` (no write attempted, nothing observed) is still
 * an error code, not an outcome."
 */
export async function runPlugStatus(deps: PlugCommandDeps, deviceQuery: string, json: boolean): Promise<number> {
  const { session, resolved } = await loginAndResolve(deps, deviceQuery);
  const raw = await session.getPropertyList(resolved.mac, resolved.model, ["P3", "P5"]);
  const reading = readPlugState(raw);

  const payload: PlugStatusJson = {
    schemaVersion: PLUG_SCHEMA_VERSION,
    command: "plug status",
    device: resolved,
    power: reading.power,
    reachable: reading.reachable,
    note: reading.note,
  };

  if (json) {
    printJson(payload);
  } else {
    printHuman(formatPlugStatusHuman(payload));
  }
  return statusExitCode(reading);
}

/**
 * `--json` shape: PlugWriteJson (src/plug.ts). Decision (D): NO sleeping,
 * NO polling, NO retry loop of any kind — one `set_property`, then exactly
 * one immediate `get_property_list` read-back.
 *
 * If `setProperty` itself throws (network/API/auth failure), that
 * propagates UNCAUGHT — the write was never accepted by Wyze, so this is a
 * plain transport/API failure, not this function's
 * confirmed/unconfirmed/contradicted outcome to report. Only a failure in
 * the READ-BACK *after* a successful write is CAUGHT and folded into
 * "unconfirmed" (decision (D)'s "the read-back could not be obtained," and
 * decision (D2)'s "a bare transport error hides that the write was already
 * accepted") — never left to surface as a bare network/API error.
 *
 * Decision (F2): this function NEVER throws for a "confirmed"/"unconfirmed"/
 * "contradicted" outcome — those are exit codes 0/9/10, and 9/10 are
 * OUTCOME codes, not error codes. It prints the normal payload above (with
 * `requested`/`observedPower`/`verification` intact) and RETURNS the code.
 * Only resolveDevice()'s own errors (ambiguous_device/not_found/8) and a
 * failed `setProperty`/`login`/`getObjectList` call (credentials_invalid/
 * network/api_error) throw, and those stay real CliErrors mapped by
 * src/cli.ts's existing error boundary to the existing `{"error":{...}}`
 * envelope — no second error shape.
 */
export async function runPlugWrite(
  deps: PlugCommandDeps,
  deviceQuery: string,
  requested: "on" | "off",
  json: boolean,
): Promise<number> {
  const { session, resolved } = await loginAndResolve(deps, deviceQuery);
  await session.setProperty(resolved.mac, resolved.model, "P3", requested === "on" ? 1 : 0);

  let reading: PlugReading;
  try {
    const raw = await session.getPropertyList(resolved.mac, resolved.model, ["P3", "P5"]);
    reading = readPlugState(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    reading = {
      power: "unknown",
      reachable: null,
      note: `the write was accepted, but the immediate read-back itself failed: ${detail}`,
    };
  }

  const result = classifyWriteOutcome(requested, reading);
  const payload: PlugWriteJson = {
    schemaVersion: PLUG_SCHEMA_VERSION,
    command: requested === "on" ? "plug on" : "plug off",
    device: resolved,
    requested,
    result,
    observedPower: reading.power,
    reachable: reading.reachable,
    verification: SINGLE_IMMEDIATE_READ,
    note: reading.note,
  };

  if (json) {
    printJson(payload);
  } else {
    printHuman(formatPlugWriteHuman(payload));
  }
  return writeResultExitCode(result);
}
