// The wrong-box guard (D7): `wyzr cycle` must REFUSE when the machine it
// runs on is the machine it is about to cut. Runs on EVERY path, including
// `--force` and `--dry-run` (dry-run REPORTS its finding rather than
// skipping the check) — see src/cycle-runner.ts, which evaluates this
// unconditionally, before it ever acts on the gate's verdict or the
// preconditions, and gives it the HIGHEST refusal priority of the three
// preamble checks (the wrong-box guard is what D7 calls "no escape hatch,
// anywhere, under any flag" — stronger even than D4's "force cannot
// override the preconditions," since force is not even in the same
// sentence as this guard anywhere in the ticket).
//
// THE TRAP THIS GUARD CREATES RATHER THAN SOLVES (the ticket's own
// framing): an instrument that cannot see the failure it exists to catch.
// A naive guard compares a configured hostname string to the local
// hostname with a bare `!==` and PASSES ("not the target") whenever they
// merely differ in FORM, even when the two strings plainly or plausibly
// name the SAME machine.
//
// ROUND 1 (WYZR-27, 2026-09-11): normalised (trim, lowercase) and
// special-cased an FQDN against its own short name as a match. Review
// caught, by MEASUREMENT before inspection, that documenting this as
// "every unresolvable case refuses" was FALSE: a DNS-alias/CNAME
// divergence and a container/VM hostname divergence both produced
// `"not_target"` (PROCEED). The epic overturned the proposed doc-only fix:
// THE CODE WAS WRONG, NOT THE DOCS.
//
// ROUND 2: replaced the special-case with a construction — compare only
// when both identities are the SAME "kind" (short hostname / FQDN-with-
// matching-domain / IP literal / container-shaped hex id), refuse on every
// cross-kind pairing. **This was ALSO wrong, caught the same way — by
// actually running it against the epic's own worked example, not by
// inspecting the rule:** `("physicalhost", "a3f9c21b4e77")` — the
// container-vs-hostname row the whole correction was ABOUT — classifies as
// two ordinary "short" hostnames under any classification rule that does
// not special-case container-id shapes, and even the special case is a
// heuristic on the STRING'S OWN SHAPE, not evidence. **The epic's actual
// finding: no pure function over two STRINGS can ever rule this out.**
// `physicalhost` and `a3f9c21b4e77` are indistinguishable in shape from
// two genuinely different hosts — the information needed to tell them
// apart is not present in the two inputs, no matter how the comparison
// rule is written. Making the string rule cleverer was never going to
// close this; round 2 was chasing a fix that does not exist at that layer.
//
// ROUND 3, THE ARCHITECTURAL FIX NOW IMPLEMENTED: if a pure function
// cannot resolve identity, it must not be the thing that clears the box.
// This module now has BOTH a pure decision core (`evaluateWrongBoxGuard()`
// — zero I/O, exhaustively testable, decides nothing it wasn't handed) AND
// an injectable identity-resolution boundary (`WrongBoxIdentityProbe`)
// that supplies REAL evidence: this machine's own network addresses
// (`getLocalAddresses()`, purely local — `os.networkInterfaces()`, no
// network I/O at all) and the configured target's own addresses, resolved
// FROM THIS MACHINE (`resolveTargetAddresses()` — DNS/hosts-file lookup,
// consulting only local resolver configuration). Same split this repo
// already uses everywhere else (`src/wedge.ts`'s pure engine vs.
// `src/wedge-probes.ts`'s injectable I/O boundary) — "unresolvable" is now
// a PROBE OUTCOME (`null`), the same first-class "could not look" shape
// `src/wedge.ts`/`src/recovery.ts` already report elsewhere, not a gap a
// smarter string rule was expected to paper over.
//
// THE CONSTRAINT THIS MECHANISM WAS CHECKED AGAINST BEFORE IT WAS BUILT:
// this verb exists for the case where the far box is DEFINITIVELY GONE —
// when the gate says PROVEN, the target does not answer network traffic,
// by construction. Any identity mechanism that needs the TARGET to answer
// (ssh to it, ping it, ask it its own machine-id) would report
// "could not look" and REFUSE exactly when this verb is needed — this
// epic's own denominator trap in a third shape, an instrument whose
// construction excludes the case it exists to serve. `resolveTargetAddresses()`
// below never contacts the target: DNS/hosts-file resolution is answered
// by the MANAGER's own resolver configuration (a DNS server, or a static
// `/etc/hosts` entry), which requires the target to have a stable
// address on record, never that it be reachable or powered on right now.
// **Operational requirement this places on deployment, stated here rather
// than assumed:** the configured target must resolve, from the machine
// `wyzr cycle` runs on, to that target's real address(es) — via DNS or a
// static hosts-file entry — independent of whether the target is
// currently up. See README's "wyzr cycle" section, "The wrong-box guard,"
// for this same requirement written out for an operator.
//
// WHAT THIS STILL CANNOT DETECT, AND DOES NOT CLAIM TO: multi-homed or
// NAT'd addressing that this machine's own resolver does not know about;
// IPv6 representational variance (a `::ffff:`-mapped IPv4 address is not
// normalised against its bare IPv4 form); and, structurally, ANY case
// where `resolveTargetAddresses()` or `getLocalAddresses()` fails or
// returns nothing — those are `"inconclusive"`, not guessed. Address-set
// overlap is real evidence a string comparison could never be — it is not
// omniscience.

import { networkInterfaces } from "node:os";
import { promises as dnsPromises } from "node:dns";

export type WrongBoxGuardOutcome = "not_target" | "is_target" | "inconclusive";

export interface WrongBoxGuardResult {
  readonly outcome: WrongBoxGuardOutcome;
  readonly reasons: readonly string[];
}

function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * THE PURE DECISION CORE — zero I/O, total over its inputs, the only place
 * a `WrongBoxGuardOutcome` is decided. Never resolves anything itself;
 * `runWrongBoxGuard()` below is the I/O layer that gathers
 * `targetAddresses`/`localAddresses` through the injectable
 * `WrongBoxIdentityProbe` boundary and hands them here — same
 * pure-engine/impure-runner split as `src/wedge.ts`/`src/wedge-runner.ts`.
 *
 * `targetAddresses === null` means the configured target could not be
 * resolved at all (DNS/hosts-file lookup failed) — "could not look,"
 * exactly like an unconfigured target or an empty `localAddresses` set
 * (this machine's own addresses could not be enumerated): all three are
 * `"inconclusive"`, never guessed either way. `is_target` requires at
 * least one address to appear in BOTH sets (this machine really is
 * something the target's name resolves to); anything else, with both
 * sides successfully resolved, is an affirmative `"not_target"` — real
 * evidence, not a shape heuristic.
 */
export function evaluateWrongBoxGuard(
  configuredTarget: string | undefined,
  targetAddresses: readonly string[] | null,
  localAddresses: readonly string[],
): WrongBoxGuardResult {
  if (!configuredTarget || configuredTarget.trim().length === 0) {
    return {
      outcome: "inconclusive",
      reasons: [
        "wrong-box guard: no configured target host — cannot affirmatively establish this machine is NOT the " +
          "target, so this REFUSES (err tight, D7)",
      ],
    };
  }

  if (targetAddresses === null) {
    return {
      outcome: "inconclusive",
      reasons: [
        `wrong-box guard: could not resolve the configured target ("${configuredTarget}") to any address from ` +
          "this machine (DNS/hosts-file lookup failed or returned nothing) — cannot affirmatively establish " +
          "this machine is NOT the target, so this REFUSES (err tight, D7); this resolution never contacts the " +
          "target itself, so a powered-off target is not why this failed — check DNS/hosts-file configuration",
      ],
    };
  }

  if (localAddresses.length === 0) {
    return {
      outcome: "inconclusive",
      reasons: [
        "wrong-box guard: could not enumerate this machine's own network addresses — cannot affirmatively " +
          "establish this machine is NOT the target, so this REFUSES (err tight, D7)",
      ],
    };
  }

  const local = new Set(localAddresses.map(normaliseAddress));
  const overlap = targetAddresses.map(normaliseAddress).filter((address) => local.has(address));

  if (overlap.length > 0) {
    return {
      outcome: "is_target",
      reasons: [
        `wrong-box guard: the configured target ("${configuredTarget}") resolves to address(es) this machine ` +
          `itself owns (${overlap.join(", ")}) — REFUSING: this machine IS the target, whatever the gate said`,
      ],
    };
  }

  return {
    outcome: "not_target",
    reasons: [
      `wrong-box guard: the configured target ("${configuredTarget}") resolves to ${targetAddresses.join(", ")}, ` +
        `none of which match this machine's own address(es) (${localAddresses.join(", ")}) — affirmatively ` +
        "established: this machine is NOT the target",
    ],
  };
}

/**
 * The injectable identity-resolution boundary — see this file's own top
 * comment for the constraint both methods were checked against (neither
 * may require the TARGET to be reachable). Handed straight to
 * `runWrongBoxGuard()`, never to `evaluateWrongBoxGuard()` itself, which
 * stays zero-I/O.
 */
export interface WrongBoxIdentityProbe {
  /** Resolves `target` to its known address(es), performed entirely by
   * THIS machine's own resolver (DNS and/or `/etc/hosts`) — never a
   * connection to `target` itself. `null` means resolution failed or
   * returned nothing; never thrown. */
  resolveTargetAddresses(target: string): Promise<readonly string[] | null>;
  /** This machine's own non-internal network addresses (every configured
   * interface, loopback excluded) — a purely local OS query, zero network
   * I/O, cannot fail because of anything about the target. Empty array on
   * a genuine enumeration failure; never thrown. */
  getLocalAddresses(): Promise<readonly string[]>;
}

/**
 * Runs the two probe calls (concurrently — neither depends on the other)
 * and hands their result to the pure decision core. The one function
 * `src/cycle-runner.ts` calls; `evaluateWrongBoxGuard()` above is exported
 * separately so `test/unit/cycle-wrong-box.test.ts` can exercise the
 * decision itself with hand-built address lists, at zero I/O.
 */
export async function runWrongBoxGuard(
  configuredTarget: string | undefined,
  probe: WrongBoxIdentityProbe,
): Promise<WrongBoxGuardResult> {
  if (!configuredTarget || configuredTarget.trim().length === 0) {
    return evaluateWrongBoxGuard(configuredTarget, null, []);
  }
  const target = configuredTarget.trim();
  const [targetAddresses, localAddresses] = await Promise.all([
    probe.resolveTargetAddresses(target),
    probe.getLocalAddresses(),
  ]);
  return evaluateWrongBoxGuard(configuredTarget, targetAddresses, localAddresses);
}

/** Real implementations elsewhere in this repo inject their I/O-performing
 * primitive (`src/wedge-probes-real.ts`'s `fetchImpl`/`runCapturing`) so
 * request construction and classification stay unit-testable with no
 * network — same pattern here: both functions below default to Node/Bun's
 * own DNS/OS bindings, but a test can inject throwing or canned ones. */
export interface RealWrongBoxIdentityProbeOptions {
  /** Defaults to a `dns.lookup(target, { all: true })`-based resolver — see
   * `defaultResolveAddresses()` below. Must THROW on failure (never return
   * `null` itself); `RealWrongBoxIdentityProbe` is what turns a throw into
   * `null`, in exactly one place. */
  resolveAddressesFn?: (target: string) => Promise<readonly string[]>;
  /** Defaults to `os.networkInterfaces()`. Must THROW on failure. */
  networkInterfacesFn?: () => ReturnType<typeof networkInterfaces>;
}

async function defaultResolveAddresses(target: string): Promise<readonly string[]> {
  const results = await dnsPromises.lookup(target, { all: true });
  return results.map((r) => r.address);
}

/** The real implementation. `resolveTargetAddresses()` is a DNS/hosts-file
 * lookup performed by THIS machine's own resolver — never a connection to
 * `target` (see this file's own top comment for why that constraint is
 * load-bearing, not incidental). `getLocalAddresses()` reads
 * `os.networkInterfaces()` and excludes loopback/internal entries, since
 * every machine has one and it never distinguishes anything. */
export class RealWrongBoxIdentityProbe implements WrongBoxIdentityProbe {
  private readonly resolveAddressesFn: (target: string) => Promise<readonly string[]>;
  private readonly networkInterfacesFn: () => ReturnType<typeof networkInterfaces>;

  constructor(opts: RealWrongBoxIdentityProbeOptions = {}) {
    this.resolveAddressesFn = opts.resolveAddressesFn ?? defaultResolveAddresses;
    this.networkInterfacesFn = opts.networkInterfacesFn ?? networkInterfaces;
  }

  async resolveTargetAddresses(target: string): Promise<readonly string[] | null> {
    try {
      const addresses = await this.resolveAddressesFn(target);
      return addresses.length > 0 ? addresses : null;
    } catch {
      return null;
    }
  }

  async getLocalAddresses(): Promise<readonly string[]> {
    try {
      const ifaces = this.networkInterfacesFn();
      const addresses: string[] = [];
      for (const entries of Object.values(ifaces)) {
        for (const entry of entries ?? []) {
          if (!entry.internal) addresses.push(entry.address);
        }
      }
      return addresses;
    } catch {
      return [];
    }
  }
}
