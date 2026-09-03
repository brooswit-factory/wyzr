// P3 (power)/P5 (reachability) decoding, get_property_list response
// parsing, the write-verb read-back outcome classification, and the
// `--json` contract types for `wyzr plug status|on|off` (WYZR-13). This is
// where the ticket's decisions (A), (D), (E), and (F) are implemented,
// together, because they all share the same P3/P5 decode primitives.
//
// docs/wyze-api-findings-2026-09-02.md's explicit unknown #1 (no captured
// real Wyze response payload exists in any (a)/(b)-tier source) applies here
// exactly as it does to src/devices.ts's get_object_list projection: the
// response shape assumed below (`data.property_list` as a list of `{pid,
// value}` entries) is this project's OWN INFERENCE, by analogy with
// get_object_list's own `data.device_list` wrapper key — not a confirmed
// contract. See README's "Live-device coverage" section.

import { ExitCode } from "./errors.ts";

/** Bump whenever a field on either JSON shape below is added, removed,
 * renamed, or changes meaning — same promise as devices.ts's
 * DEVICE_LIST_SCHEMA_VERSION. See README's "--json contract" section. */
export const PLUG_SCHEMA_VERSION = 1;

export type PowerState = "on" | "off" | "unknown";
export type Reachable = true | false | null;

/**
 * Decision (A): a CLOSED, boolean-rejecting whitelist. Accepts exactly the
 * two wire values the finding documents for `P3` (§Q4: `PropDef("P3", bool,
 * int, [0, 1])` — presented to callers as a bool, wire type int restricted
 * to two values) — the number `1`/`0`, and the string `"1"`/`"0"`
 * (defensive, mirroring src/devices.ts's `classifyState()` precedent).
 * Everything else, INCLUDING a native JSON boolean `true`/`false`, decodes
 * to `"unknown"` — a boolean is precisely the silently-wrong wire assumption
 * the finding warns about, so it is REJECTED, never helpfully coerced. See
 * test/unit/plug.test.ts's boolean-rejection test (ticket requirement: a
 * test that fails if this code ever starts accepting a boolean).
 */
export function decodeP3(value: unknown): PowerState {
  if (value === 1 || value === "1") return "on";
  if (value === 0 || value === "0") return "off";
  return "unknown";
}

/** Same closed whitelist as decodeP3, for `P5` (reachability) — also
 * documented by the finding as int 0/1. `null` (not `"unknown"`) is this
 * module's spelling of "undecodable," mirroring how the existing error
 * contract already uses `null` for "nothing finer to say." Deliberately
 * independent of decodeP3 — reachability must never be inferred from `P3`,
 * per decision (D); see readPlugState() below and its test. */
export function decodeP5(value: unknown): Reachable {
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function describeType(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Same fragment-safety rule as src/devices.ts's fieldNote(): names a field
 * and what was expected, and reports only the value's TYPE — never any part
 * of the value itself. Decision (G). */
function fieldNote(field: string, expected: string, value: unknown): string {
  return `field "${field}": expected ${expected}, got ${describeType(value)}`;
}

interface ParsedProperties {
  values: Map<string, unknown>;
  note: string | null;
}

/**
 * Parses a `get_property_list` response's `data` into a pid -> value map.
 * `data.property_list` as a LIST of `{pid, value}` entries (this module's
 * top comment) is this project's inference — a response that isn't shaped
 * that way is deliberately NOT thrown as a hard error here, unlike
 * src/devices.ts's malformedDeviceListError(): decision (E) already routes
 * "P3/P5 came back undecodable" through `state_unknown`, so a malformed
 * property-list response reaches that same outcome via an empty map plus a
 * fragment-safe note (see readPlugState()), rather than a separate crash
 * path — ticket item 7's "recoverable parse error ... never a silent
 * misread," applied by folding into the SAME recoverable outcome the
 * decode-level unknowns already produce.
 */
function parsePropertyList(raw: unknown): ParsedProperties {
  if (typeof raw !== "object" || raw === null) {
    return { values: new Map(), note: fieldNote("(property_list data)", "an object", raw) };
  }
  const list = (raw as Record<string, unknown>)["property_list"];
  if (!Array.isArray(list)) {
    return { values: new Map(), note: fieldNote("property_list", "an array", list) };
  }

  const values = new Map<string, unknown>();
  const notes: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      notes.push(fieldNote("(property_list entry)", "an object", entry));
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const pid = obj["pid"];
    if (typeof pid !== "string" || pid.length === 0) {
      notes.push(fieldNote("pid", "a non-empty string", pid));
      continue;
    }
    values.set(pid, obj["value"]);
  }
  return { values, note: notes.length > 0 ? notes.join("; ") : null };
}

export interface PlugReading {
  power: PowerState;
  reachable: Reachable;
  note: string | null;
}

/**
 * Reads `P3` (power) and `P5` (reachability) out of a `get_property_list`
 * response. Decision (D)/(E)'s central rule lives here: `P5` is looked up
 * and decoded INDEPENDENTLY of `P3` — reachability is NEVER inferred from
 * `P3`'s value, and a `P3`-known/`P5`-unknown reading never claims a
 * confident state (see PLUG_SCHEMA doc and test/unit/plug.test.ts).
 */
export function readPlugState(raw: unknown): PlugReading {
  const { values, note: parseNote } = parsePropertyList(raw);
  const p3Raw = values.get("P3");
  const p5Raw = values.get("P5");
  const power = decodeP3(p3Raw);
  const reachable = decodeP5(p5Raw);

  const notes: string[] = [];
  if (parseNote) notes.push(parseNote);
  if (power === "unknown") notes.push(fieldNote("P3", '1, 0, "1", or "0"', p3Raw));
  if (reachable === null) notes.push(fieldNote("P5", '1, 0, "1", or "0"', p5Raw));

  return { power, reachable, note: notes.length > 0 ? notes.join("; ") : null };
}

export interface PlugDeviceJson {
  mac: string;
  model: string;
  name: string;
}

/** `plug status`'s `--json` success shape — decision (F). */
export interface PlugStatusJson {
  schemaVersion: number;
  command: "plug status";
  device: PlugDeviceJson;
  power: PowerState;
  reachable: Reachable;
  note: string | null;
}

export type WriteResult = "confirmed" | "unconfirmed" | "contradicted";

/** Decision (D2)'s second bullet, made machine-readable: literally how many
 * read-backs were attempted and how long was waited between the write and
 * the read. Always `{ readBacks: 1, waitedMs: 0 }` in this codebase — decision
 * (D) forbids any sleep/poll/retry — but a caller must not have to trust
 * that as an unstated assumption; it is a field it can check for itself,
 * and the one thing that lets it decide on its own whether to re-read on a
 * schedule of its own choosing to rule out propagation lag. */
export interface VerificationJson {
  readBacks: number;
  waitedMs: number;
}

/** The only `verification` value this codebase ever produces — decision
 * (D) forbids a second read-back or any wait, so this is a constant, not
 * something computed per call. Exported so src/cli-plug.ts never has to
 * spell the literal out (and risk it drifting from the one decision (D)
 * actually implements). */
export const SINGLE_IMMEDIATE_READ: VerificationJson = { readBacks: 1, waitedMs: 0 };

/** `plug on`/`plug off`'s `--json` success shape — decision (F), with the
 * `verification` object decision (D2) requires. */
export interface PlugWriteJson {
  schemaVersion: number;
  command: "plug on" | "plug off";
  device: PlugDeviceJson;
  requested: "on" | "off";
  result: WriteResult;
  observedPower: PowerState;
  reachable: Reachable;
  verification: VerificationJson;
  note: string | null;
}

/**
 * Decision (D)'s three-outcome classification, from a post-write read-back
 * against the requested power. `power === "unknown"` is checked FIRST and
 * wins over a mismatch check: an undecodable reading is always
 * "unconfirmed," never miscategorized as "contradicted" just because
 * `"unknown" !== requested`.
 */
export function classifyWriteOutcome(requested: "on" | "off", reading: PlugReading): WriteResult {
  if (reading.power === "unknown") return "unconfirmed";
  if (reading.power === requested) return "confirmed";
  return "contradicted";
}

export function writeResultExitCode(result: WriteResult): ExitCode {
  if (result === "confirmed") return ExitCode.Ok;
  if (result === "unconfirmed") return ExitCode.StateUnknown;
  return ExitCode.WriteContradicted;
}

/** Decision (E): exit `0` requires BOTH `P3` and `P5` decodable — a `P5` of
 * `false` (confirmed unreachable) still counts as decodable and does not,
 * on its own, force `state_unknown`; only an undecodable (`null`) `P5` (or
 * an undecodable `power`) does. */
export function statusExitCode(reading: PlugReading): ExitCode {
  return reading.power !== "unknown" && reading.reachable !== null ? ExitCode.Ok : ExitCode.StateUnknown;
}

function reachableLabel(reachable: Reachable): string {
  if (reachable === true) return "reachable";
  if (reachable === false) return "UNREACHABLE — this reading may be stale";
  return "reachability undetermined";
}

/** Human-readable `plug status` output. Decision (E)'s hardest rule: NEVER
 * print a bare "on"/"off" when either `P3` or `P5` is undecodable — the
 * entire reason `P5` is read at all is to keep "off" and "unknown" from
 * being conflated in exactly this string. */
export function formatPlugStatusHuman(payload: PlugStatusJson): string {
  const label = `${payload.device.name} (${payload.device.mac})`;
  const known = payload.power !== "unknown" && payload.reachable !== null;

  if (!known) {
    const gaps: string[] = [];
    if (payload.power === "unknown") gaps.push("power");
    if (payload.reachable === null) gaps.push("reachability");
    return (
      `${label}: STATE UNKNOWN — ${gaps.join(" and ")} could not be determined. ` +
      'This is NOT the same as "off" — do not treat an unknown reading as off.' +
      (payload.note ? ` (${payload.note})` : "")
    );
  }

  return `${label}: ${payload.power.toUpperCase()} (${reachableLabel(payload.reachable)})`;
}

/**
 * Human-readable `plug on`/`plug off` output. Decision (D2)'s wording rule
 * is implemented here, word for word:
 * - "unconfirmed" says plainly the write WAS accepted and the state is
 *   unknown (both halves, never just one — "state unreadable" is not "the
 *   write did nothing").
 * - "contradicted" reports ONLY what was observed (a disagreeing read-back)
 *   and explicitly disclaims the stronger claim: it must NEVER say the
 *   write "failed", because a contradicted read-back is equally consistent
 *   with a write that actually succeeded and simply had not propagated by
 *   the time of this single, immediate, no-wait read. See
 *   test/unit/plug.test.ts's wording-rule test (ticket requirement 8: "A
 *   test asserts the wording rule, not just the exit code").
 */
export function formatPlugWriteHuman(payload: PlugWriteJson): string {
  const label = `${payload.device.name} (${payload.device.mac})`;
  const requested = payload.requested.toUpperCase();

  if (payload.result === "confirmed") {
    return `${label}: confirmed ${requested} (${reachableLabel(payload.reachable)}).`;
  }

  if (payload.result === "unconfirmed") {
    return (
      `${label}: the request to turn the plug ${requested} WAS ACCEPTED by Wyze, but the resulting state ` +
      "could NOT be read back (unknown). Do not assume the write worked, and do not assume it did not." +
      (payload.note ? ` (${payload.note})` : "")
    );
  }

  return (
    `${label}: the request to turn the plug ${requested} was accepted by Wyze. An immediate read-back shows ` +
    `the plug is currently ${payload.observedPower.toUpperCase()}, not ${requested} — this disagreement is ` +
    "exactly as consistent with propagation lag (Wyze has not reflected the change yet) as with a write that " +
    "had no effect; wyzr took exactly one read with no wait, so it cannot tell those two apart. Do not " +
    `conclude the plug did not turn ${requested} — re-read its status separately, on your own schedule, to ` +
    "see whether it catches up."
  );
}
