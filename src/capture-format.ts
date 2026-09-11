// The CAPTURE FORMAT (WYZR-29, deliverable 2): what a human executor
// records when they run a real check on the manager box — the only channel
// through which reality reaches this repo (see this ticket's own framing;
// no agent can ever run wyzr for real). See docs/capture-format.md for the
// full spec, the worked end-to-end example, and the address-handling rule
// this module enforces in code.
//
// THE ADDRESS-DISCLOSURE BOUNDARY THIS MODULE OWNS: `src/cycle-wrong-box.ts`'s
// `not_target` trail interpolates every resolved target address and every
// local non-internal address, and that reaches BOTH `wyzr doctor --json` and
// `wyzr cycle --dry-run --json` (see src/cli-doctor.ts's/src/cycle-report.ts's
// own `wrongBoxGuard.reasons`). The epic ruled that disclosure load-bearing
// and acceptable WHERE IT IS READ (an operator's own screen) — this module
// is what makes it safe on the OTHER surface, the paste-back path into a
// ticket: `redactAddressesForPasteBack()` is the one function every
// captured command's raw output passes through before
// `renderCaptureForPasteBack()` ever emits it. It does NOT touch the
// diagnostics an operator reads on their own screen — this module is never
// imported by src/output.ts or any command's own human/`--json` rendering;
// it exists ONLY on the executor's own paste-back path, a manual step
// downstream of the command, so the operator-facing surface stays exactly
// as legible as the epic's own ruling requires.
//
// WHAT THIS MODULE DOES NOT AND CANNOT DO: catch a secret, a device mac, a
// plug name, a fleet hostname, or a systemd unit — none of those has a
// detectable SHAPE the way an IPv4/IPv6/IPv4-mapped-IPv6 literal does (see
// canonicaliseAddress() in src/cycle-wrong-box.ts for the address shapes
// this module mirrors). The capture format's own template
// (docs/capture-format.md) carries that obligation procedurally instead:
// every field asks for a PLACEHOLDER value, the same discipline
// docs/config.example.json already uses, and never for a value copied
// verbatim off a real manager box.

const IPV4_MAPPED_IPV6 = /::ffff:(?:\d{1,3}\.){3}\d{1,3}/gi;
const IPV4_DOTTED_QUAD = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * Candidate IPv6-shaped runs. Deliberately permissive at the EXTRACTION
 * stage (2 to 7 colons) — `isIPv6Shaped()` below is what actually decides
 * whether a candidate is redacted, specifically so an ISO-8601 timestamp's
 * time part (`15:26:26.144Z`, exactly 2 colons, 3 groups) is extracted as a
 * candidate but then REJECTED, never redacted. A real IPv6 address is
 * either exactly 8 groups (no compression) or contains the literal `::`
 * compression marker — a plain HH:MM:SS clock time can be neither: it never
 * has 4+ colon-separated groups, and it never contains two consecutive
 * colons. This is the one property this module leans on to tell the two
 * shapes apart without a full address-vs-timestamp grammar.
 */
const IPV6_CANDIDATE = /\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/g;

function isIPv6Shaped(candidate: string): boolean {
  if (candidate.includes("::")) return true;
  return candidate.split(":").length >= 4;
}

export const ADDRESS_REDACTED = "<address-redacted>";

/**
 * Scrubs every IPv4, IPv6 (compressed or fully expanded), and IPv4-mapped
 * IPv6 literal out of `text`, replacing each with `ADDRESS_REDACTED`. Order
 * matters: IPv4-mapped IPv6 is replaced FIRST (whole token, including the
 * `::ffff:` prefix) so the later plain-IPv4 pass never partially matches
 * the embedded dotted-quad inside one and leaves the prefix looking like an
 * address fragment. Required test: test/unit/capture-format.test.ts
 * constructs a payload using `evaluateWrongBoxGuard()` — the REAL function,
 * not a hand-typed string shaped to make this pass — with placeholder
 * addresses in each of the three shapes, and asserts none of those literal
 * substrings survive.
 */
export function redactAddressesForPasteBack(text: string): string {
  let out = text.replace(IPV4_MAPPED_IPV6, ADDRESS_REDACTED);
  out = out.replace(IPV6_CANDIDATE, (match) => (isIPv6Shaped(match) ? ADDRESS_REDACTED : match));
  out = out.replace(IPV4_DOTTED_QUAD, ADDRESS_REDACTED);
  return out;
}

/**
 * What an executor records for ONE real check run against reality. Every
 * field is required — see docs/capture-format.md for the full template and
 * why each one earns its place. `expectedBeforeRun` is read and filled in
 * BEFORE `rawOutput`/`exitCode` exist, structurally enforced by this being
 * the field this type declares first and the section
 * `renderCaptureForPasteBack()` renders first — a format that only records
 * outcomes lets an executor rationalise a result after seeing it (the
 * ticket's own rule).
 */
export interface CaptureRecord {
  /** What result would make this run FAIL — written down before the
   * command is run, never edited after. */
  readonly expectedBeforeRun: string;
  /** The exact command run, verbatim — placeholders for any host/plug/mac,
   * per docs/capture-format.md's own template rule. */
  readonly command: string;
  /** ISO-8601. */
  readonly startedAt: string;
  /** ISO-8601. */
  readonly finishedAt: string;
  readonly exitCode: number;
  /** The exact, complete output the command produced (human or `--json`),
   * BEFORE paste-back redaction — `renderCaptureForPasteBack()` redacts it;
   * never store a pre-redacted copy as the source of truth, or a later
   * reader cannot verify the redaction was applied correctly. */
  readonly rawOutput: string;
  /** The executor's own one-line verdict against `expectedBeforeRun` —
   * "matches expectation" or "CONTRADICTS expectation: <what differed>". */
  readonly verdict: string;
}

/**
 * Renders one `CaptureRecord` as a paste-back-ready block: expectation
 * first, then command, timing, exit code, the REDACTED output, then the
 * verdict last — comparable across runs because every run produces the
 * same section order and headings, so a reader (or a future automated
 * diff) can align two captures of the same check line for line.
 */
export function renderCaptureForPasteBack(record: CaptureRecord): string {
  return [
    "### Expectation (stated before running)",
    record.expectedBeforeRun,
    "",
    "### Command",
    "```",
    record.command,
    "```",
    "",
    "### Timing",
    `- started: ${record.startedAt}`,
    `- finished: ${record.finishedAt}`,
    "",
    "### Result",
    `- exit code: ${record.exitCode}`,
    "```",
    redactAddressesForPasteBack(record.rawOutput),
    "```",
    "",
    "### Verdict",
    record.verdict,
  ].join("\n");
}

/**
 * Converts a `CaptureRecord` into a `PROVENANCE: CAPTURED-LIVE` doc-comment
 * ready to paste directly above a new fixture function in
 * src/transport-fake.ts (or a sibling fixture module) — see that file's own
 * top comment for the exact tag format this mirrors. The date is read
 * straight off `record.startedAt`, never something the reader has to go
 * dig up separately — "convertible ... without having to reconstruct
 * anything," per the ticket. `descriptor` is the one thing this function
 * cannot derive from the record itself (what the fixture actually
 * represents, e.g. "devices list, placeholder-credential probe") — the
 * same free-text slot transport-fake.ts's own tags already carry.
 *
 * NOTE: this does NOT redact addresses — a fixture is source code reviewed
 * before it merges, not a paste-back into a ticket; scrubbing it here would
 * make a captured fixture unable to reproduce the real shape it exists to
 * pin. Redaction is this module's OWN paste-back-path concern
 * (`renderCaptureForPasteBack()`), a DIFFERENT surface from a merged
 * fixture, which is exactly the "two different surfaces" split this
 * ticket's address-disclosure section draws.
 */
export function toProvenanceFixtureComment(record: CaptureRecord, descriptor: string): string {
  const date = record.startedAt.slice(0, 10);
  return (
    `/** PROVENANCE: CAPTURED-LIVE, ${descriptor}, ${date}, captured via:\n` +
    ` *   ${record.command}\n` +
    ` * Expectation stated before the run: ${record.expectedBeforeRun}\n` +
    ` * Verdict: ${record.verdict} */`
  );
}
