// The narrow injected plug-control boundary `wyzr cycle` uses to read a
// plug's P3/P5 state and write its power — deliberately its OWN interface,
// not a reuse or widening of anything src/wedge-probes.ts or
// src/recovery-probes.ts publish (those are about the wedge/recovery
// engines' own evidence, not about controlling a plug at all — the ticket's
// explicit "do not widen WedgeProbes, do not add a plug field to
// RecoveryInput"), and deliberately NOT src/cli-plug.ts's
// runPlugWrite()/runPlugStatus(), which are CLI-shaped (they print, they
// pick an exit code) rather than a plain I/O boundary an orchestration
// module can inject.
//
// TWO interfaces, not one, and the split is what makes R5 (dry-run must be
// STRUCTURALLY incapable of writing) a compiler-checked property rather
// than a convention: `PlugReader` exposes only readState(); `PlugWriter`
// adds writePower() on top of it. src/cycle-runner.ts's dry-run entry
// point (runCycleDryRun) is typed to accept only a PlugReader — a write
// call inside that function's body does not typecheck, because the
// parameter's static type has no such method, not because a runtime flag
// happens to guard it. A PlugWriter passed in at the call site still works
// as an argument (structural subtyping — a PlugWriter IS a PlugReader),
// but everywhere INSIDE a function whose parameter is typed PlugReader,
// only readState() is visible to the compiler.

import { readPlugState, type PlugReading } from "./plug.ts";
import type { WyzeAuthSession } from "./auth-session.ts";
import type { ResolvedDevice } from "./device-resolve.ts";

export interface PlugReader {
  /** Reads P3 (power) and P5 (reachability) fresh — never cached — via the
   * SAME primitive src/plug.ts's `plug status`/`plug on`/`plug off` use
   * (readPlugState()), reused rather than reimplemented. Throws on a
   * genuine transport/auth/API failure (nothing was observed at all);
   * never throws for an observed-but-undecodable reading — that comes back
   * as a `PlugReading` with `power: "unknown"` and/or `reachable: null`,
   * exactly like src/plug.ts's own read path. */
  readState(): Promise<PlugReading>;
}

/** Adds the one write this verb ever performs: setting P3. Deliberately no
 * other method — this interface cannot express turning on any OTHER
 * property, reading anything else, or batching several writes. */
export interface PlugWriter extends PlugReader {
  /** Issues exactly one `set_property` call for P3. Throws on a genuine
   * transport/auth/API failure — the caller (src/cycle-runner.ts) decides
   * what a thrown write means for THIS verb's own R1/R2 rules; this
   * interface makes no claim about how many times it may be called — that
   * discipline lives entirely in the orchestration, not here. */
  writePower(value: "0" | "1"): Promise<void>;
}

/**
 * The real implementation: wraps an already-authenticated WyzeAuthSession
 * (src/auth-session.ts) and an already-resolved device
 * (src/device-resolve.ts) — both constructed once by src/cli-cycle.ts,
 * exactly like src/cli-plug.ts's loginAndResolve() does for `plug
 * status|on|off`. This class performs no login, no device resolution, and
 * no retry of its own — see this module's top comment for why those stay
 * out of this narrow boundary.
 */
export class RealCyclePlugTransport implements PlugWriter {
  constructor(
    private readonly session: WyzeAuthSession,
    private readonly device: ResolvedDevice,
  ) {}

  async readState(): Promise<PlugReading> {
    const raw = await this.session.getPropertyList(this.device.mac, this.device.model, ["P3", "P5"]);
    return readPlugState(raw);
  }

  async writePower(value: "0" | "1"): Promise<void> {
    await this.session.setProperty(this.device.mac, this.device.model, "P3", value);
  }
}
