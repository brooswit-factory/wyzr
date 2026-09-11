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
// hostname with a bare `!==` and PASSES (declares "not the target")
// whenever they merely differ in FORM — a case difference, whitespace, or
// an FQDN vs its own short name — even though those three shapes plainly
// name the SAME machine. `evaluateWrongBoxGuard()` below closes exactly
// that gap: it normalises (trim, lowercase, and compares both the full and
// the short-name form) before comparing, and separately REFUSES outright
// — rather than guessing — in the three cases where it cannot even
// perform a direct comparison at all: no configured target, an unreadable
// local identity, or the two identities being in different FORMATS (an IP
// literal against a hostname, which this function does not resolve).
//
// WHAT REMAINS OPEN, STATED PLAINLY RATHER THAN OVERCLAIMED (an earlier
// version of this comment claimed more than the code does here, caught by
// review — see evaluateWrongBoxGuard()'s own doc comment below for the
// full account and the falsifying measurement): a DNS alias/CNAME, or a
// container/VM hostname diverging from its physical host's own name, are
// NOT detected — two strings that differ for either of those reasons but
// genuinely name the same machine will read "not_target" here. This
// function performs no DNS resolution and no container/host identity
// query, on purpose (see evaluateWrongBoxGuard()'s own comment for why),
// so that gap is closed by
// CONFIGURATION discipline — the target must be set to the exact string
// this machine's own `os.hostname()` returns — not by this function.

import { hostname } from "node:os";

export type WrongBoxGuardOutcome = "not_target" | "is_target" | "inconclusive";

export interface WrongBoxGuardResult {
  readonly outcome: WrongBoxGuardOutcome;
  readonly reasons: readonly string[];
}

const IP_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** The part before the first `.` — an FQDN's short name, or the whole
 * string when there is no `.` at all. */
function shortName(value: string): string {
  const idx = value.indexOf(".");
  return idx === -1 ? value : value.slice(0, idx);
}

/**
 * CORRECTED BY REVIEW (WYZR-27, 2026-09-11): an earlier version of this
 * comment (and of the README's own description) claimed this function
 * returns "inconclusive" for a DNS-alias/CNAME divergence and for a
 * container/VM hostname diverging from its physical host's own name. THAT
 * WAS FALSE, and it was caught by measurement, not inspection — falsified
 * with three constructed calls: `evaluateWrongBoxGuard("fleetbox.internal.example",
 * "srv-07")` and `evaluateWrongBoxGuard("physicalhost", "a3f9c21b4e77")`
 * both return `"not_target"` (the PROCEED side), not `"inconclusive"` —
 * only `evaluateWrongBoxGuard("10.9.8.7", "srv-07")` (the IP-vs-hostname
 * format mismatch) actually refuses. The docs asserted a fail-safe this
 * function does not implement — see this file's own top comment and the
 * PR discussion for the full account of why that is exactly the class of
 * defect this epic exists to catch, one layer out, in prose rather than
 * in a `reasons` string.
 *
 * THE ACCURATE STATEMENT, going forward:
 *
 * EXACTLY THREE CASES REFUSE (return `"is_target"` or `"inconclusive"`,
 * never `"not_target"`): (1) `configuredTarget` is unset/blank; (2)
 * `localHostname` could not be read; (3) the two identities are in
 * different FORMATS — one looks like an IPv4 literal, the other does not
 * — which this function treats as inconclusive because it performs no
 * DNS resolution and so cannot compare an IP literal against a hostname
 * at all. Two SAME-FORMAT strings are compared directly (trim, lowercase,
 * and, for two hostnames only, also by the short-name-before-the-first-dot
 * form) — an exact, deterministic STRING comparison, nothing more.
 *
 * WHAT THIS FUNCTION CANNOT DETECT, AND DOES NOT CLAIM TO: a DNS alias or
 * CNAME this project has never resolved, and a container/VM hostname that
 * differs from its physical host's own name. If `configuredTarget` and
 * `localHostname` are two DIFFERENT STRINGS that happen to name the SAME
 * machine through either of those mechanisms, this function returns
 * `"not_target"` — the machine proceeds. THIS IS A REAL, UNCLOSED GAP, not
 * a corner case papered over by "inconclusive." Deliberately not closed
 * here: resolving DNS or querying a container/VM's own physical-host
 * identity would turn this pure, synchronous, zero-I/O string comparison
 * into a call that can itself fail, hang, be spoofed, or simply disagree
 * with the manager's own view of the network — trading one class of risk
 * (an undetected alias) for another (a guard whose own correctness now
 * depends on DNS/container infrastructure this repo does not control). If
 * that trade is ever revisited, it is a deliberate, argued code change —
 * not a doc fix.
 *
 * THE GAP IS CLOSED BY CONFIGURATION DISCIPLINE INSTEAD: set
 * `WYZR_CYCLE_WRONG_BOX_TARGET_HOST` to the EXACT string
 * `os.hostname()` returns when run ON the machine `wyzr cycle` is meant to
 * cut — never a DNS alias, a CNAME, or a name inferred from outside that
 * machine. An operator can confirm this by running `hostname` (or `wyzr
 * cycle <device> --dry-run`, which reports the guard's own finding) ON
 * the target machine itself and comparing it byte-for-byte against the
 * configured value — see README's "wyzr cycle" section, "The wrong-box
 * guard," for this same guidance written out for an operator.
 *
 * WHAT THIS NORMALISATION DOES COVER, for two same-format strings:
 * leading/trailing whitespace, case, and FQDN-vs-short-name (compares
 * both the full normalised string and the short-name-before-the-first-dot
 * form; a match on EITHER is treated as the SAME machine — the
 * false-"same" direction is the SAFE direction here, since this guard's
 * job on a same-format pair is to catch sameness, and over-matching two
 * representations of the identical hostname is harmless).
 */
export function evaluateWrongBoxGuard(
  configuredTarget: string | undefined,
  localHostname: string | null,
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
  if (!localHostname || localHostname.trim().length === 0) {
    return {
      outcome: "inconclusive",
      reasons: [
        "wrong-box guard: this machine's own hostname could not be read — cannot affirmatively establish this " +
          "machine is NOT the target, so this REFUSES (err tight, D7)",
      ],
    };
  }

  const target = normalise(configuredTarget);
  const local = normalise(localHostname);

  // Full-string equality always applies first, regardless of format —
  // this is what catches two identical IP literals (or two identical
  // hostnames) before anything format-specific below runs.
  if (local === target) {
    return {
      outcome: "is_target",
      reasons: [
        `wrong-box guard: this machine's hostname ("${localHostname}") matches the configured target ` +
          `("${configuredTarget}") after normalisation (trim, lowercase) — REFUSING: this machine IS the ` +
          "target, whatever the gate said",
      ],
    };
  }

  const targetIsIp = IP_LIKE.test(target);
  const localIsIp = IP_LIKE.test(local);
  if (targetIsIp !== localIsIp) {
    return {
      outcome: "inconclusive",
      reasons: [
        `wrong-box guard: the configured target ("${configuredTarget}") and this machine's own identity ` +
          `("${localHostname}") are in different formats (one looks like an IPv4 literal, the other a hostname) ` +
          "— this guard performs no DNS resolution and cannot establish whether they name the same machine, so " +
          "this REFUSES (err tight, D7) rather than guessing",
      ],
    };
  }

  // The short-name-before-the-first-dot comparison ONLY makes sense for
  // hostnames (an FQDN vs its own short form) — applying it to an IP
  // literal would treat "10.0.0.5" and "10.0.0.6" as the same "short name"
  // ("10"), which is exactly the false-"same" mistake this guard must
  // never make in the SAFE direction reversed: it would make two
  // DIFFERENT machines look identical. Both sides are already confirmed
  // to be the same format (both IP or both hostname) by the check above,
  // so this only ever fires for two hostnames.
  if (!targetIsIp && !localIsIp) {
    const targetShort = shortName(target);
    const localShort = shortName(local);
    if (localShort === targetShort) {
      return {
        outcome: "is_target",
        reasons: [
          `wrong-box guard: this machine's hostname ("${localHostname}") matches the configured target ` +
            `("${configuredTarget}") by short-name-before-the-first-dot after normalisation (trim, lowercase) ` +
            "— REFUSING: this machine IS the target, whatever the gate said",
        ],
      };
    }
  }

  return {
    outcome: "not_target",
    reasons: [
      `wrong-box guard: this machine's hostname ("${localHostname}") does NOT match the configured target ` +
        `("${configuredTarget}") under normalisation (trim, lowercase, and — for two hostnames — compared by ` +
        "short-name-before-the-first-dot too) — affirmatively established: this machine is NOT the target",
    ],
  };
}

/** Reads this machine's own hostname — the one piece of I/O this guard
 * needs. Injectable so test/unit/cycle-wrong-box.test.ts can exercise
 * evaluateWrongBoxGuard() directly with hand-built strings, and so
 * src/cycle-runner.ts never reaches for `os.hostname()` itself. */
export interface LocalIdentityProbe {
  /** `null` means unreadable — never thrown; a probe failure is exactly
   * the "local identity unreadable" case evaluateWrongBoxGuard() already
   * treats as inconclusive. */
  getLocalHostname(): Promise<string | null>;
}

/** Real implementations elsewhere in this repo inject their I/O-performing
 * primitive (src/wedge-probes-real.ts's `fetchImpl`/`runCapturing`) so
 * request construction and classification stay unit-testable with no
 * network — same pattern here: `hostnameFn` defaults to Node/Bun's own
 * `os.hostname()`, but a test can inject a throwing one to exercise the
 * catch branch below without needing this OS call to ever actually fail. */
export interface RealLocalIdentityProbeOptions {
  hostnameFn?: () => string;
}

/** The real implementation: Node/Bun's own `os.hostname()`. This is the
 * ONLY place `wyzr cycle` reads THIS machine's identity from — no ssh, no
 * subprocess, nothing that could be confused with reading the SUSPECT
 * box's identity instead of this one's own. */
export class RealLocalIdentityProbe implements LocalIdentityProbe {
  private readonly hostnameFn: () => string;

  constructor(opts: RealLocalIdentityProbeOptions = {}) {
    this.hostnameFn = opts.hostnameFn ?? hostname;
  }

  async getLocalHostname(): Promise<string | null> {
    try {
      const value = this.hostnameFn();
      return value && value.trim().length > 0 ? value : null;
    } catch {
      return null;
    }
  }
}
