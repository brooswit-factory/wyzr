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
// hostname and PASSES (declares "not the target") whenever they merely
// differ in FORM — FQDN vs short name, an alias, a case difference, an IP
// vs a name, an unset config read as empty-string-not-equal. That guard
// never actually identifies the box; it just fails to notice a match. Err
// tight instead: evaluateWrongBoxGuard() below only ever returns
// "not_target" when it can AFFIRMATIVELY show the two names are different
// under every normalisation it knows how to apply; every other case —
// including every case a naive string `!==` would have silently passed —
// is "inconclusive" and REFUSES.

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
 * WHAT THIS NORMALISATION COVERS: leading/trailing whitespace, case, and
 * FQDN-vs-short-name (compares both the full normalised string and the
 * short-name-before-the-first-dot form; a match on EITHER is treated as
 * the SAME machine — the false-"same" direction is the SAFE direction for
 * this specific guard, since its whole job is to catch sameness).
 *
 * WHAT IT DOES NOT COVER, ON PURPOSE (each of these is a case where this
 * function returns "inconclusive" rather than guessing "not the target"):
 * it does not resolve DNS (a CNAME or an alias this project has never
 * heard of), it does not compare an IP literal against a hostname (no
 * reverse/forward lookup is performed — see the IP-format-mismatch branch
 * below), and it knows nothing about a container/VM hostname diverging
 * from its physical host's own name. Any of those is a REAL way for
 * `local` and `target` to name the same machine without matching here —
 * which is exactly why an inconclusive comparison REFUSES rather than
 * passing: a false "not the target" is the dangerous direction for this
 * guard (D7), so every gap in what this normalisation can establish falls
 * on the refuse side, never the proceed side.
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
