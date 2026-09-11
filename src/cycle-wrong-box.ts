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
// ROUND 4 (WYZR-27, 2026-09-11): round 3 disclosed "IPv6 representational
// variance is not normalised" as a residual limitation, next to genuine
// probe failure, as if both were the same kind of gap. Review caught,
// again by MEASUREMENT (a real Linux host, not an argument): they are NOT
// the same kind of gap. (a) A target resolving to a LOOPBACK address
// (Debian/Ubuntu's own default — `/etc/hosts` maps a machine's own
// hostname to `127.0.1.1`, and `dns.lookup()` returns it) could never
// overlap `getLocalAddresses()`'s own loopback-EXCLUDING set — `wyzr
// cycle` run ON the target, configured EXACTLY per this file's own
// guidance, resolved not_target and PROCEEDED, on precisely the case this
// guard exists to catch. Fixed: `isLoopbackAddress()` below treats ANY
// loopback address the TARGET resolves to as unambiguous evidence THIS
// machine is the target, independent of `localAddresses` entirely. (b) An
// IPv4-mapped IPv6 spelling (`::ffff:10.0.0.5`) against its plain IPv4
// form, and two differently-compressed spellings of the identical IPv6
// address, are not a "cannot resolve" gap at all — they are the SAME
// address, spelled two ways, the identical class of problem as the
// hostname trim/lowercase this guard already did. Fixed:
// `canonicaliseAddress()` below reduces both forms to one representation
// before any comparison.
//
// WHAT THIS STILL CANNOT DETECT, AND DOES NOT CLAIM TO: multi-homed or
// NAT'd addressing that this machine's own resolver does not know about at
// all (a genuine "the information is not in the inputs" gap, not a
// normalisation problem — this is NOT the same class as (b) above); and,
// structurally, ANY case where `resolveTargetAddresses()` or
// `getLocalAddresses()` fails or returns nothing — those are
// `"inconclusive"`, not guessed. Address-set overlap (now over
// canonicalised addresses, with loopback resolved as a special case) is
// real evidence a string comparison could never be — it is not
// omniscience.

import { networkInterfaces } from "node:os";
import { promises as dnsPromises } from "node:dns";

export type WrongBoxGuardOutcome = "not_target" | "is_target" | "inconclusive";

export interface WrongBoxGuardResult {
  readonly outcome: WrongBoxGuardOutcome;
  readonly reasons: readonly string[];
}

const IPV4_LOOKALIKE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/**
 * Expands a bare IPv6 address (no IPv4-mapped suffix — see
 * `canonicaliseAddress()`, which handles that case first) to its full
 * 8-group, leading-zero-free, lowercase form — e.g. `2001:db8::1` and
 * `2001:0db8:0000:0000:0000:0000:0000:1` both become
 * `2001:db8:0:0:0:0:0:1`. `null` for anything not IPv6-shaped at all.
 * ROUND 4 (WYZR-27, 2026-09-11): without this, two textually different
 * spellings of the identical address compared as plain strings — never a
 * "cannot resolve" gap, a pure normalisation problem this guard already
 * solves for hostnames (trim/case) but had not yet solved for addresses.
 */
function expandIPv6(value: string): string | null {
  if (!value.includes(":")) return null;
  const segments = value.split("::");
  if (segments.length > 2) return null; // more than one "::" is not valid IPv6
  let head: string[];
  let tail: string[];
  if (segments.length === 2) {
    head = segments[0] ? segments[0].split(":") : [];
    tail = segments[1] ? segments[1].split(":") : [];
  } else {
    head = value.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const normalisedGroups: string[] = [];
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null;
    normalisedGroups.push(parsed.toString(16));
  }
  return normalisedGroups.join(":");
}

/**
 * Reduces an address string to ONE canonical form so textually different
 * spellings of the identical address compare equal — trim/lowercase
 * (shared with hostname normalisation elsewhere in this file), an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.5`) reduced to its plain IPv4
 * form, and a bare IPv6 address fully expanded (see `expandIPv6()`).
 * Anything this function does not recognise (a plain IPv4 literal, or a
 * genuinely unparseable string) passes through unchanged — this function
 * only ever makes two representations of the SAME address compare equal;
 * it never invents equality between two different addresses.
 */
function canonicaliseAddress(address: string): string {
  const value = address.trim().toLowerCase();
  const v4Mapped = IPV4_MAPPED_IPV6.exec(value);
  if (v4Mapped) return v4Mapped[1]!;
  if (IPV4_LOOKALIKE.test(value)) return value;
  return expandIPv6(value) ?? value;
}

/**
 * ROUND 4 (WYZR-27, 2026-09-11): a loopback address (`127.0.0.0/8`,
 * `::1`) resolved for the CONFIGURED TARGET is, by definition, THIS
 * machine — `resolveTargetAddresses()` is answered by this machine's own
 * resolver, and a loopback address can never mean any OTHER machine, no
 * matter whose name resolved to it. This is NOT a comparison against
 * `localAddresses` (which deliberately excludes loopback — see
 * `WrongBoxIdentityProbe.getLocalAddresses()` — since every machine
 * shares the same loopback address, so it is useless for telling machines
 * APART; but showing up as the TARGET's OWN resolution is a completely
 * different, and unambiguous, kind of evidence).
 *
 * WHY THIS MATTERS IN PRACTICE, caught by review measuring a real Linux
 * host rather than arguing about one: Debian/Ubuntu's default
 * `/etc/hosts` maps a machine's own hostname to `127.0.1.1` (not just
 * `127.0.0.1`), and `dns.lookup()` (this module's resolver, chosen
 * BECAUSE it consults `/etc/hosts`) returns that address for the
 * machine's own hostname. Without this check, `wyzr cycle` run ON the
 * target machine, with the target CONFIGURED CORRECTLY per this file's
 * own guidance (the exact string `os.hostname()` returns), would resolve
 * the target to a loopback address that never overlaps the (loopback-
 * excluding) local set — `not_target`, PROCEED, on precisely the case
 * this guard exists to catch. Checked BEFORE this line ever ran: watched
 * it fail exactly this way, transcript in the PR.
 */
// `canonicaliseAddress("::1")` fully expands to "0:0:0:0:0:0:0:1" (see
// expandIPv6()) — this constant is that same expansion, not the
// compressed spelling, so the comparison below actually matches what this
// function is ever handed. Verified by the "IPv6 loopback ::1" test: this
// line originally compared against the literal `"::1"` and never matched
// anything, since every address here has already been through
// canonicaliseAddress() by the time isLoopbackAddress() sees it — caught
// by that test failing on first run, not by inspection.
const CANONICAL_IPV6_LOOPBACK = "0:0:0:0:0:0:0:1";

function isLoopbackAddress(canonicalAddress: string): boolean {
  return canonicalAddress === CANONICAL_IPV6_LOOPBACK || canonicalAddress.startsWith("127.");
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

  // WYZR-28: THE EMPTY-SET HOLE. An empty (but non-null) `targetAddresses`
  // array used to fall straight through the `=== null` check above,
  // reach the final "not_target" branch, and CLEAR VACUOUSLY (an empty
  // set trivially "overlaps nothing" with anything) — on a verb that cuts
  // mains power. Same voice, same outcome, as the `null` branch just
  // above: "the target could not be resolved" and "the target resolved to
  // NOTHING" are the same kind of missing evidence from this function's
  // point of view, so both REFUSE rather than one of them proceeding.
  // Unreachable through shipped code today
  // (`RealWrongBoxIdentityProbe.resolveTargetAddresses()` converts an
  // empty resolver result to `null` in exactly one place, pinned by its
  // own "returns null ... when the injected resolver resolves to zero
  // addresses" test) — this is the defense-in-depth fix at the PURE CORE
  // itself, so the hole cannot reopen if that one conversion is ever
  // removed or a second caller ever hands this function a raw resolver
  // result directly.
  if (targetAddresses.length === 0) {
    return {
      outcome: "inconclusive",
      reasons: [
        `wrong-box guard: the configured target ("${configuredTarget}") resolved an EMPTY address list from this ` +
          "machine (DNS/hosts-file lookup succeeded but returned nothing) — cannot affirmatively establish this " +
          "machine is NOT the target, so this REFUSES (err tight, D7); this resolution never contacts the target " +
          "itself, so a powered-off target is not why this failed — check DNS/hosts-file configuration",
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

  const canonicalTargetAddresses = targetAddresses.map(canonicaliseAddress);

  // Checked BEFORE the overlap comparison, and independently of
  // `localAddresses` — see isLoopbackAddress()'s own comment for why a
  // loopback resolution is unambiguous evidence regardless of what the
  // (loopback-excluding) local set contains.
  const loopbackTargetAddresses = canonicalTargetAddresses.filter(isLoopbackAddress);
  if (loopbackTargetAddresses.length > 0) {
    return {
      outcome: "is_target",
      reasons: [
        `wrong-box guard: the configured target ("${configuredTarget}") resolves to a LOOPBACK address ` +
          `(${loopbackTargetAddresses.join(", ")}) — a loopback address can only ever mean the machine that ` +
          "resolved it, i.e. THIS machine, regardless of what its own non-loopback interfaces report — " +
          "REFUSING: this machine IS the target, whatever the gate said",
      ],
    };
  }

  const local = new Set(localAddresses.map(canonicaliseAddress));
  const overlap = canonicalTargetAddresses.filter((address) => local.has(address));

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
