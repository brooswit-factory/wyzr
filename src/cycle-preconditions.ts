// D1's before-the-cut precondition: cloud reachability AND a readable plug
// state (BOTH P3 and P5 decoding), checked IMMEDIATELY BEFORE the OFF
// would be attempted. "The power-off is the point of no return, and an
// operator who cannot turn the plug back ON must never be allowed to turn
// it off."
//
// Composed entirely from src/plug.ts's own read primitives via a single
// src/cycle-plug.ts `PlugReader.readState()` call — a successful call that
// decodes both P3 and P5 IS, in one observation, proof both halves of the
// precondition hold: reaching a decodable get_property_list response
// requires having reached Wyze's cloud API at all (login + the device-host
// call both succeeded), and P3/P5 both decoding is exactly src/plug.ts's
// own "state known" rule (see readPlugState()/statusExitCode() there) —
// nothing here re-derives that decode logic.
//
// THE STRUCTURAL HALF OF D4: this function is the ONLY place in this
// codebase that can construct a PreconditionsClearedWitness — see that
// type's own comment. src/cycle-runner.ts's performOff() REQUIRES one as a
// parameter, so "skip the preconditions and cut power anyway" is not
// expressible by threading one more flag through a function — there is no
// flag that produces a witness; only a "cleared" result from
// evaluatePreconditions() does.

import type { PlugReader } from "./cycle-plug.ts";
import type { PlugReading } from "./plug.ts";

/**
 * A branded, effectively unforgeable witness that the before-the-cut
 * preconditions were evaluated and cleared. The brand key is a MODULE-
 * PRIVATE unique symbol, never exported — so no other file can even NAME
 * this property, let alone write a value for it, short of an explicit
 * `{} as unknown as PreconditionsClearedWitness` type-cast (a deliberate,
 * visible lie to the type system a reviewer would have to wave through, not
 * a parameter someone threads through by accident — see D4: "a boolean
 * parameter threaded through a function is not structural... someone adds
 * `skipPreconditions: true` next year and nothing breaks"). This is
 * stronger than this repo's existing `__brand: "some-literal-string"`
 * convention (src/wedge.ts, src/recovery.ts): a string-literal brand is
 * still a property anyone can spell and assign; a non-exported unique
 * symbol key cannot be spelled by any code outside this module at all.
 * See test/unit/cycle-preconditions.test.ts's type-level pin.
 */
const WITNESS: unique symbol = Symbol("cycle-preconditions-cleared");
export interface PreconditionsClearedWitness {
  readonly [WITNESS]: true;
}

export type PreconditionsOutcome = "cleared" | "cloud_unreachable" | "plug_state_unreadable";

export interface PreconditionsResult {
  readonly outcome: PreconditionsOutcome;
  readonly reasons: readonly string[];
  /** The reading this decision was made from — `null` only when the read
   * itself threw (cloud_unreachable), since nothing was observed at all. */
  readonly reading: PlugReading | null;
  /** Present only when `outcome === "cleared"` — see this module's own
   * top comment. */
  readonly witness: PreconditionsClearedWitness | null;
}

/**
 * The one read this precondition needs. Never throws: a genuine transport
 * failure is caught and reported as `cloud_unreachable` (this is a
 * REFUSAL src/cycle-runner.ts reports as its own outcome, not an error the
 * CLI boundary should map to a generic exit code).
 */
export async function evaluatePreconditions(plug: PlugReader): Promise<PreconditionsResult> {
  let reading: PlugReading;
  try {
    reading = await plug.readState();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      outcome: "cloud_unreachable",
      reasons: [
        `preconditions: could not reach the cloud to read the plug's state before cutting power (${detail}) — ` +
          "REFUSING: an operator who cannot turn the plug back ON must never be allowed to turn it off (D1)",
      ],
      reading: null,
      witness: null,
    };
  }

  const known = reading.power !== "unknown" && reading.reachable !== null;
  if (!known) {
    return {
      outcome: "plug_state_unreadable",
      reasons: [
        "preconditions: the plug's state could not be read confidently before cutting power (power=" +
          `${reading.power}, reachable=${String(reading.reachable)}${reading.note ? `, ${reading.note}` : ""}) — ` +
          "REFUSING: an operator who cannot turn the plug back ON must never be allowed to turn it off (D1)",
      ],
      reading,
      witness: null,
    };
  }

  return {
    outcome: "cleared",
    reasons: [
      "preconditions: cloud reachable and plug state read confidently before cutting power (power=" +
        `${reading.power}, reachable=${String(reading.reachable)}) — preconditions cleared`,
    ],
    reading,
    witness: { [WITNESS]: true },
  };
}
