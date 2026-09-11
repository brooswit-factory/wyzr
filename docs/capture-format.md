# The capture format

`wyzr` is forbidden to run on the fleet box it protects (a lever must not
live on the thing it operates), and no agent runs it anywhere else either —
it installs only on the operator's manager box, which no agent's own
workspace is. The **only** channel through which reality reaches this repo is a named,
willing human executor running a real command, once, on the manager box,
and recording what they saw. They cannot ask a follow-up question
mid-run. Loose prose cannot be fixtured, compared across runs, or used to
settle a disagreement about what actually happened — so the format in
which an executor records an observation is a real engineering artifact in
its own right, not paperwork around one.

This document is that format. `src/capture-format.ts` implements the one
part of it that has to be code (the paste-back redaction rule) and is
tested in `test/unit/capture-format.test.ts`.

## The template

Fill in every field **before** running the command, except the ones this
template explicitly marks "after":

```
### Expectation (stated before running)
<What result would make this FAIL? Be specific: an exit code, a field
value, a verdict string. If you cannot write this down, stop — running
the command will not tell you anything you can act on.>

### Command
<The EXACT command, verbatim, as you are about to type it. Use a
PLACEHOLDER for any real hostname, plug name, device mac, IP address,
port, systemd unit, or credential — the same discipline
docs/config.example.json already uses. Never paste a real one, even
though this section never leaves your own screen until you paste it
somewhere.>

### Timing (after)
- started: <ISO-8601, UTC>
- finished: <ISO-8601, UTC>

### Result (after)
- exit code: <the integer, captured DIRECTLY — see the warning below>
<The command's complete output, `--json` preferred. Paste it through
`redactAddressesForPasteBack()` (or by hand, replacing any IPv4/IPv6/
IPv4-mapped-IPv6 literal with `<address-redacted>`) before it leaves your
own screen — see "The address-disclosure boundary" below.>

### Verdict (after)
<One line: "matches expectation" or "CONTRADICTS expectation: <exactly
what differed>." Never rationalize a contradicted expectation into a
pass — a contradiction is itself the finding.>
```

`src/capture-format.ts`'s `CaptureRecord` type is this same template as a
plain TypeScript object, and `renderCaptureForPasteBack()` renders it in
this exact section order — expectation first, structurally, not by
convention (see that function's own test: "the expectation section renders
BEFORE the result section").

**Capture the exit code directly**, never off the end of a pipe:
`cmd > log 2>&1; echo "exit=$?"` — `cmd | head; echo $?` reports `head`'s
exit status, not the command's, and has already recorded a false `0` for a
command that actually exited `1` or `3` on this epic (see this ticket's own
brief). The same warning applies to every exit code an executor captures
with this template, not just this repo's own gate.

## Why expectation comes before result

A format that only records outcomes lets an executor rationalize a result
after seeing it — "well, exit 4 basically means the same thing as exit 0
here" is a sentence that only gets written once the exit code is already
known. Writing the falsification criterion down first, before the command
runs, is what makes "contradicts expectation" a finding a reader can trust
instead of a post-hoc gloss.

## Comparable across runs

Two captures of the same check, taken weeks apart, must be diffable
line-for-line by a human (or a future script) — that is what "comparable"
means here. This template achieves it structurally: the same five section
headings, in the same order, every time. `renderCaptureForPasteBack()`'s
own test pins this ("two captures of the SAME check produce the same
section headings in the same order").

## The address-disclosure boundary

`src/cycle-wrong-box.ts`'s wrong-box guard interpolates every resolved
target address and every local non-internal address into its own evidence
trail (`reasons`), and that reaches `wyzr doctor --json` and
`wyzr cycle --dry-run --json` alike (`wrongBoxGuard.reasons` on both). The
epic ruled that disclosure **load-bearing and acceptable where it is
READ**: an operator staring at a mistaken refusal needs the actual
addresses to diagnose it, and counts alone would make the refusal
undiagnosable — that is the "lever nobody dares pull" failure this whole
product exists to prevent. **The boundary the epic drew: fine where it is
READ, handled where it is TRANSMITTED.**

Pasting `--json` output into a ticket is exactly the transmission the
epic's ruling was about. This capture format is the paste-back path, so it
owns the other half of that boundary:

- **Diagnostics an operator reads on their own screen are never touched.**
  `src/capture-format.ts` is not imported by `src/output.ts` or by any
  command's own human/`--json` rendering — nothing this module does can
  reach a live terminal. It runs only when an executor is about to paste a
  captured transcript somewhere else.
- **The paste-back copy has every IPv4, IPv6 (compressed or fully
  expanded), and IPv4-mapped IPv6 literal replaced with
  `<address-redacted>`**, via `redactAddressesForPasteBack()`. Required
  test (`test/unit/capture-format.test.ts`): built from
  `evaluateWrongBoxGuard()` — the real function, with placeholder addresses
  in each of the three shapes `canonicaliseAddress()` recognizes — never a
  hand-typed string shaped to make the test pass, so it proves this
  actually catches what the guard actually emits, not a guess at it.
- **Hostnames, plug names, and macs are NOT auto-detected** — unlike an
  address, none of those has a checkable shape a regex can reliably tell
  apart from ordinary prose. That obligation is procedural instead: the
  template above asks for a placeholder in the `### Command` section
  before the command is even run, the same discipline
  `docs/config.example.json` already applies to this whole repo.
- **Registering a secret with `src/redact.ts`'s registry does not protect
  you from printing a PIECE of it** — that registry matches whole
  registered strings only. It cannot catch one character of a secret, and
  it cannot protect a value nobody registered in the first place. The one
  real leak this product ever shipped was fixed by POSITION ONLY (report
  presence/position/permission, never content — see `wyzr doctor`'s own
  README section). Never assume the redaction registry is a safety net for
  a paste-back; it was never built to be one.

## Worked example, end to end, from SYNTHETIC placeholder data

Every value below is a placeholder — no part of this example was captured
against a real account, a real device, or a real host.

**Step 1 — filled-in template**, an executor capturing `wyzr devices list --json`:

```
### Expectation (stated before running)
Exit 0. `device_list` contains exactly one entry, mac=FIXTURE-MAC-0000,
model=WLPP1CFH.

### Command
wyzr devices list --json

### Timing
- started: 2026-09-11T15:00:00.000Z
- finished: 2026-09-11T15:00:02.000Z

### Result
- exit code: 0
{"devices":[{"mac":"FIXTURE-MAC-0000","model":"WLPP1CFH","name":"fixture plug","state":"online"}]}

### Verdict
matches expectation
```

**Step 2 — the same thing as a `CaptureRecord`** (`src/capture-format.ts`):

```ts
const record: CaptureRecord = {
  expectedBeforeRun: "exit 0, device_list contains exactly one entry with mac=FIXTURE-MAC-0000",
  command: "wyzr devices list --json",
  startedAt: "2026-09-11T15:00:00.000Z",
  finishedAt: "2026-09-11T15:00:02.000Z",
  exitCode: 0,
  rawOutput: '{"devices":[{"mac":"FIXTURE-MAC-0000","model":"WLPP1CFH"}]}',
  verdict: "matches expectation",
};
```

**Step 3 — converted into a provenance-tagged fixture comment**, ready to
paste directly above a new fixture function in `src/transport-fake.ts` (or
a sibling fixture module), via `toProvenanceFixtureComment(record, "devices
list, placeholder-credential probe")`:

```
/** PROVENANCE: CAPTURED-LIVE, devices list, placeholder-credential probe, 2026-09-11, captured via:
 *   wyzr devices list --json
 * Expectation stated before the run: exit 0, device_list contains exactly one entry with mac=FIXTURE-MAC-0000
 * Verdict: matches expectation */
```

The date (`2026-09-11`) is read straight off `record.startedAt` — a later
reader does not reconstruct it from anything. This exact tag format is
`src/transport-fake.ts`'s own convention (see that file's top comment); a
reviewer merging a real captured fixture drops this comment in unchanged
and writes the actual fixture body below it.

**Note what this step does NOT do**: `toProvenanceFixtureComment()` never
redacts addresses. A merged fixture is source code, reviewed on its own PR
before it lands — it needs the REAL shape it exists to pin, which is a
different surface from the paste-back path into a ticket comment. Scrubbing
it here would produce a fixture that cannot reproduce the thing it was
captured to prove. This is the same "two different surfaces" split as the
address-disclosure boundary above, applied one step further down the
pipeline.

## What this format is not

It does not replace `report_to_boss`/`ask_boss`/a PR description — it is
the payload a human pastes INTO one of those, not a new channel of its
own. It does not make an assumption a measurement — a filled-in template
whose expectation was written down after the fact, or whose verdict
rationalizes a contradiction into a pass, is worse than no capture at all,
because it reads as evidence while carrying none.
