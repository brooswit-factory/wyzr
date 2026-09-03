// Field-allowlisted projection of Wyze's `get_object_list` response onto
// this CLI's own DeviceRecord shape, plus the human-readable formatter.
//
// THE HARDEST RULE IN THE TICKET: this module builds its output by NAMING
// each field it exposes, one at a time (stringField()/classifyState()
// below) — never by spreading the raw API object and deleting fields it
// does not want. A denylist silently leaks whatever the API adds tomorrow
// that nobody anticipated today; docs/wyze-api-findings-2026-09-02.md
// warns reverse-engineered APIs "routinely include tokens and account
// identifiers" beyond what was asked for. See
// test/unit/devices.test.ts's "allowlist, not denylist" tests for the
// red-first proof, and the PR body for the exact red output observed when
// this was temporarily switched to a spread.
//
// docs/wyze-api-findings-2026-09-02.md's explicit unknown #1: no captured
// example of a real `get_object_list` response was found in any (a)/(b)-
// tier source. Every field name read below (`mac`, `product_model`,
// `nickname`, `conn_state`) is therefore this project's own inference
// (tier (d)), not a confirmed contract — see README's "devices list"
// section for exactly what that means per field, and expect correction
// against a real account.

import { CliError, ExitCode } from "./errors.ts";

/** Bump this whenever a field is added, removed, renamed, or changes
 * meaning — the only versioning promise this contract makes. See README's
 * "--json contract" section. */
export const DEVICE_LIST_SCHEMA_VERSION = 1;

export type DeviceState = "online" | "offline" | "unknown";

export interface DeviceRecord {
  /** The identifier device-control calls key on, per the finding's Q4
   * table (`mac`/`model` pair, or `device_ids`) — `null` when this entry's
   * `mac` field was missing or not a non-empty string. A `null` mac means
   * this row cannot be acted on by a later command; it is still shown
   * (never dropped) so the operator can see something is there. */
  mac: string | null;
  /** The device's `product_model` — paired with `mac` for device-control
   * calls per the finding. `null` when missing/malformed. */
  model: string | null;
  /** `nickname`, or a clear placeholder when missing/malformed — never
   * blank, so a row is never silently unreadable. */
  name: string;
  /** `true` only when `model` matched this project's own KNOWN_PLUG_MODELS
   * set. This set is NOT sourced from the finding (which documents no
   * model-code table at all) and is known to be incomplete — see
   * KNOWN_PLUG_MODELS's own comment. `false` means "not recognized as a
   * known plug model," NOT "confirmed not a plug" — a real plug with an
   * unrecognized model code would also read `false`. Consumers must not
   * treat `false` as proof of anything; it is why this command marks
   * rather than filters (see README / PR body). */
  isPlug: boolean;
  /** Derived from `conn_state` (this project's own inference of where
   * get_object_list signals connectivity — distinct from the P5 property,
   * which is a separate get_property_list call this ticket's scope
   * defence excludes entirely). `"unknown"` whenever `conn_state` is
   * missing or not exactly `0`/`1`/`"0"`/`"1"` — never guessed. */
  state: DeviceState;
  /** `null` on a clean row. Otherwise names which field(s) on this raw
   * entry were missing or an unexpected type, and what was expected —
   * NEVER any part of the field's actual value (see fieldNote() below;
   * this is the same fragment-safety rule as src/totp.ts's
   * base32Decode()). Included in the documented `--json` contract as an
   * optional diagnostic; absent/`null` on every row in ordinary operation. */
  note: string | null;
}

/**
 * This project's own inference (tier (d), corroborated only at tier (c) at
 * best) of which `product_model` codes name a Wyze plug —
 * docs/wyze-api-findings-2026-09-02.md documents no model-code table at
 * all, so this is NOT a confirmed contract. `"WLPP1"` matches the value
 * WYZR-11's own fake response already uses for its synthetic plug
 * (src/transport-fake.ts's fakeGetObjectListEnvelope()).
 *
 * Deliberately treated as INCOMPLETE, never as a denylist's mirror image:
 * an unrecognized model sets `isPlug: false` but the row is still shown
 * (see the "list-everything-and-mark" choice in the PR body) — a
 * filter-by-default design built on this same incomplete list would risk
 * hiding an operator's actual plug, which is unacceptable for a tool whose
 * whole purpose is finding the plug that reboots a wedged box.
 */
const KNOWN_PLUG_MODELS = new Set<string>(["WLPP1"]);

function describeType(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Names a field and what was expected of it — and, per the ticket's item
 * 5, NEVER any part of `value` itself, only its type/shape class. A field
 * on an untrusted, reverse-engineered API response can hold a token or
 * account identifier (the finding warns this is routine); quoting "the
 * offending value" here would be the exact bug WYZR-11 shipped
 * (`Invalid base32 character: "X"`) in a new place. Position/type is
 * metadata, not content.
 */
function fieldNote(field: string, expected: string, value: unknown): string {
  return `field "${field}": expected ${expected}, got ${describeType(value)}`;
}

function stringField(obj: Record<string, unknown>, field: string, notes: string[]): string | null {
  const value = obj[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  notes.push(fieldNote(field, "a non-empty string", value));
  return null;
}

function classifyState(obj: Record<string, unknown>, notes: string[]): DeviceState {
  const raw = obj["conn_state"];
  if (raw === 1 || raw === "1") return "online";
  if (raw === 0 || raw === "0") return "offline";
  notes.push(fieldNote("conn_state", '0, 1, "0", or "1"', raw));
  return "unknown";
}

function projectDevice(raw: unknown): DeviceRecord {
  if (typeof raw !== "object" || raw === null) {
    return {
      mac: null,
      model: null,
      name: "(malformed device entry)",
      isPlug: false,
      state: "unknown",
      note: fieldNote("(device entry)", "an object", raw),
    };
  }
  const obj = raw as Record<string, unknown>;
  const notes: string[] = [];
  const mac = stringField(obj, "mac", notes);
  const model = stringField(obj, "product_model", notes);
  const nickname = stringField(obj, "nickname", notes);
  const state = classifyState(obj, notes);

  return {
    mac,
    model,
    name: nickname ?? "(unnamed device)",
    isPlug: model !== null && KNOWN_PLUG_MODELS.has(model),
    state,
    note: notes.length > 0 ? notes.join("; ") : null,
  };
}

function malformedDeviceListError(reason: string): CliError {
  return new CliError(
    `Wyze's device list response was not shaped as this project expected (${reason}). ` +
      "docs/wyze-api-findings-2026-09-02.md's unknown #1 is that no real get_object_list response has ever " +
      "been observed by this project — this may be exactly that mismatch, not a bug in wyzr.",
    ExitCode.ApiError,
    "wyze_device_list_malformed",
  );
}

/**
 * Projects Wyze's raw `get_object_list` `data` (as returned by
 * `WyzeAuthSession.getObjectList()`) onto `DeviceRecord[]` — see this
 * module's own top comment for the allowlist-not-denylist rule.
 *
 * Deliberate, defended malformed-data strategy (per the ticket's explicit
 * requirement to choose one and defend it):
 * - A single device entry with a missing/wrong-typed field never drops
 *   that row and never crashes the whole command — it becomes a PARTIAL
 *   ROW with an explicit, fragment-safe `note` (null identifier fields, a
 *   fallback name, `isPlug: false`, `state: "unknown"` as appropriate).
 *   An emergency operator must never have a real plug silently vanish
 *   from the list because one field came back oddly shaped.
 * - Only a response that is not shaped like a device list AT ALL (`data`
 *   is not an object, or has no `device_list` array) is treated as a hard
 *   failure (`ExitCode.ApiError`, `wyze_device_list_malformed`) — at that
 *   point there is nothing per-row left to salvage.
 */
export function projectDeviceList(raw: unknown): DeviceRecord[] {
  if (typeof raw !== "object" || raw === null) {
    throw malformedDeviceListError("its data was not an object");
  }
  const list = (raw as Record<string, unknown>)["device_list"];
  if (!Array.isArray(list)) {
    throw malformedDeviceListError('its data had no "device_list" array');
  }
  return list.map(projectDevice);
}

function formatDeviceLine(device: DeviceRecord): string {
  const marker = device.isPlug ? "[PLUG]" : "[?]   ";
  const mac = device.mac ?? "(no identifier)";
  const model = device.model ?? "(unknown model)";
  const suffix = device.note ? "  (partial data — see --json for details)" : "";
  return `${marker} ${mac}  ${model}  "${device.name}"  ${device.state}${suffix}`;
}

/** Human-readable rendering — every device is listed (never filtered),
 * marked `[PLUG]` or `[?]` per `isPlug`. See KNOWN_PLUG_MODELS's comment
 * for why marking, not filtering, is this command's design. */
export function formatDeviceListHuman(devices: DeviceRecord[]): string {
  if (devices.length === 0) {
    return "No devices found on this account.";
  }
  return devices.map(formatDeviceLine).join("\n");
}
