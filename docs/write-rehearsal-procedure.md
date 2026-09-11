# The staged write rehearsal — executor procedure

**You are a named, willing, committed human executor on the manager box.
You cannot ask the authors of this document a follow-up question mid-run.**
This page is written for exactly that constraint: every step states what
result would mean STOP, before you perform it, not after.

## What this is, and why it exists

`plug on`/`plug off` — and therefore `wyzr cycle`, which is built entirely
on the same primitives — have never run through this product, by anyone,
ever, as of the date this page was written. `wyzr rehearse-safe-plug-write`
is the deliberate, staged first exercise of that write path, against a
plug chosen SPECIFICALLY because it is not the fleet box's own plug and you
can reach it directly. Running it, once, and recording what happened, is
what turns "we believe the write API works" into "this code performed a
write, on this date, and here is what it observed."

**This is not a substitute for `wyzr cycle`'s own gate, wrong-box guard, or
recovery verdict.** It proves the write primitives — nothing about the
fleet box, nothing about a real power cycle.

## The rule that overrides everything else on this page

**No agent runs this command. Ever, for any reason.** If you are an agent
reading this page, stop — this procedure is not for you, and running any
step below would be treated as an incident. This page is written for a
human, on the manager box, who has chosen to be here.

**There is no "run it from the fleet box" escape hatch.** Do not run this
command from, or against credentials/config sourced from, the fleet box.
This procedure does not offer that as a fallback under any circumstance,
including "just this once to check something."

## Ground-truth discipline — read this before step 1

**Take every host, port, systemd unit, journal command, and file path from
YOUR OWN box's authoritative source, never from this page.** This document
was written on a different machine, reading this repo at one commit. Any
host/port/path/unit named in it — including in a code comment this
procedure tells you to go read — is potentially stale or simply wrong for
your box. Concretely:

- **Your `config.json`** (`<XDG_CONFIG_HOME or $HOME/.config>/wyzr/config.json`
  on the manager box) is the only source of truth for which plug is your
  configured safe plug. Do not trust a plug name or mac you recall from a
  ticket, a chat message, or an earlier run — re-read the file, right now,
  before you start.
- **A repo citation in this page (a file path, a line number, a function
  name) is a pointer for you to verify, not a fact to act on.** If this
  page says "see `src/config.ts`'s `samePlugIdentity()`", go read that
  file at the commit you are actually running, rather than trusting this
  page's description of what it does.
- **A plausible-but-wrong fact here is silently wrong, never an error —
  and you may be reading this during an outage**, when double-checking
  feels like friction. Check anyway. That friction is the point.

## Before you start

1. **You have already performed the read acceptance** (`wyzr devices
   list`, `wyzr plug status <safe plug>`, and/or `wyzr doctor`) against
   this same account, successfully, and you trust its result. *If you have
   not*: stop here and do that first — this rehearsal assumes login,
   device resolution, and a P3/P5 read already work for this account, on
   this box. Running the write rehearsal as your FIRST-ever interaction
   with this account tells you nothing about whether a failure is the
   write path or something more basic.
2. **Run `wyzr doctor`.** *If its verdict is not `READY`*: stop. Fix
   whatever it reports before touching the write rehearsal — a doctor
   verdict that is not READY means something upstream of the write (config,
   credentials, cloud reachability, or plug resolvability) is already
   broken, and a write attempted on top of that tells you nothing you can
   act on.
3. **Confirm you can identify, physically or through its normal Wyze app
   control, the plug `wyzr doctor`'s output names as your `safePlug`** —
   not by name alone (a name can be mis-typed in config), but by its
   reported mac matching a device you can verify. *If you cannot confirm
   this*: stop. Do not proceed on a plug you cannot independently verify.

## Confirm the safe plug is safe to toggle RIGHT NOW

This is the one judgment call this procedure cannot make for you, because
it depends on what the plug is currently powering and whether interrupting
it, right now, is acceptable.

4. **Look at (or ask whoever is responsible for) whatever the safe plug
   currently powers, and confirm out loud or in writing that a several-
   -minute interruption, right now, is acceptable.** *If it is not*: stop.
   Come back at a different moment. There is no urgency to this rehearsal
   that overrides this judgment.
5. **Confirm you personally (or someone reachable right now) can restore
   this plug's power BY HAND** — its own physical switch, or its normal
   Wyze app control — independent of `wyzr` entirely. *If you cannot*:
   stop. This command's own restore is a never-give-up RETRY, not a
   guarantee — see "What STRANDED means" below — and this procedure
   requires a hand fallback to exist before you start, not after you
   discover you need one.

## Before you run: write down what would make this FAIL

**Do this before the invocation below, not after you see its output** —
see `docs/capture-format.md` for why order matters here. Fill in this
template now, on your own screen:

```
### Expectation (stated before running)
<Exit 0 (confirmed), the safe plug's own mac in the output, and no
address/hostname/plug-name/secret in what you are about to paste anywhere.
Write your OWN specific expectation — this is a placeholder, not the
answer.>
```

## The exact invocation

6. **Run, from the manager box, using YOUR OWN authoritative `wyzr`
   install:**

   ```sh
   wyzr rehearse-safe-plug-write --dry-run --json
   ```

   **This is a PREVIEW — it cannot write, structurally (it is handed a
   read-only boundary at the type level; see `src/rehearsal-runner.ts`'s
   own top comment).** *If its `outcome` is not `would_write`*: STOP —
   read what it reports (`refused_same_as_fleet_plug` or
   `refused_by_precondition`) and fix that before proceeding; do not
   re-run with the confirm flag hoping for a different result. A
   `refused_same_as_fleet_plug` result, in particular, means your config's
   own safe-plug/fleet-plug identifiers are suspect — treat this as
   serious and stop entirely; do not attempt to work around it.

7. **Only once step 6 reports `would_write`, run the confirmed write:**

   ```sh
   wyzr rehearse-safe-plug-write \
     --confirm-write-i-have-chosen-this-moment \
     --json
   ```

   This prints the SAME preview again (the evidence trail, printed BEFORE
   anything is acted on), then interactively asks you to type the exact
   configured safe plug's name back. **Type it exactly.** *If what you see
   printed as the target name does not match the plug you confirmed in
   step 3*: stop, answer anything else (the confirmation refuses on any
   non-exact answer), and re-check your config before trying again.

   (A non-interactive `--non-interactive-confirm-target=<name>` form
   exists for scripted use — same exact-match rule. Do not use it as a way
   to skip reading the preview.)

## What each outcome means, and what to record

Every outcome is printed as a normal `--json` payload — nothing about a
refusal is a crash.

- **`confirmed` (exit 0).** The write happened, the plug's own read-back
  confirmed it is back ON. This is the result you are hoping for. Record
  the FULL `--json` output (through the capture-format redaction step
  below) — this is the evidence that moves the write path from "never
  exercised" to "exercised, once, on this date."
- **`stranded` (loudest possible outcome — see below).** The OFF was
  attempted and the restore never confirmed within its bound. **Read "What
  STRANDED means" immediately, do not skip it.**
- **`refused_by_precondition`.** The cloud could not be reached, or the
  safe plug's state could not be read confidently, immediately before the
  write would have been attempted — nothing was cut. Re-run `wyzr doctor`
  to diagnose before retrying.
- **`refused_same_as_fleet_plug`.** The configured safe plug and fleet
  plug appear to be the same device. **Treat this as serious — stop and
  escalate; do not attempt to bypass it.** This should be structurally
  impossible through a loading config (`src/config.ts` refuses to load a
  conflated config at all) — seeing this outcome in practice would itself
  be a significant, reportable finding.

## What STRANDED means, and what to do

**`stranded` does NOT mean nothing happened. It means: power on the SAFE
PLUG (not the fleet box) is OFF, and this command's own automated restore
— which retries for several minutes, never giving up on its own — could
not confirm it came back on within that bound.** This is never reported as
success, and this procedure does not treat it as one either.

8. **Go to the safe plug now** — its physical switch, or its normal Wyze
   app control (the same fallback you confirmed you had in step 5) — **and
   restore its power by hand.**
9. **Record, in your own words, in the capture (below): that this
   happened, when, and how you restored it.** A STRANDED result is not a
   failure of THIS rehearsal to be useful — a stranded-and-hand-recovered
   run is real, valuable evidence about the restore path's own limits, as
   long as it is reported as what it was, not quietly smoothed over.
10. **Do not immediately re-run the command against the same plug** to
    "see if it works this time." If the restore did not confirm once,
    understand why (a genuine plug/network issue? a timing bound too
    tight for this specific plug?) before trying again — re-running blind
    treats a real finding as noise.

## Recording the run (the capture format)

`docs/capture-format.md` is the format. Concretely, for this rehearsal:

11. **Take the `expectedBeforeRun` you wrote in "Before you run" above**,
    the exact command from step 7, the timestamps you observed, the exit
    code (captured DIRECTLY — `cmd > log 2>&1; echo "exit=$?"`, never off
    the end of a pipe: see this repo's own `CHANGELOG.md`/ticket history
    for why a piped exit code has already been silently wrong once on
    this epic), and the full `--json` output, and fill in
    `docs/capture-format.md`'s template (or build a `CaptureRecord`
    directly via `src/capture-format.ts` if you are doing this from a
    checkout with `bun` available).
12. **Before pasting the `### Result` section anywhere outside your own
    screen, run it through `redactAddressesForPasteBack()`** (or, by hand,
    replace any IPv4/IPv6/IPv4-mapped-IPv6 literal with
    `<address-redacted>`). This command's own output legitimately includes
    your safe plug's configured NAME and MAC (identifiers are deliberately
    legible on the screen you are reading — see `wyzr doctor`'s own README
    section for why) — **the capture format's own address-redaction rule
    does not scrub those**, so do it by hand: **replace the safe plug's
    mac and any hostname with a placeholder yourself before pasting**,
    exactly the discipline `docs/config.example.json` already uses. **No
    address, mac, plug name, hostname, port, systemd unit, or secret
    should survive into whatever you paste into a ticket.**
13. **If the run was `confirmed`, and you want this to become a
    provenance-tagged fixture** (a permanent, reviewed record in this
    repo, e.g. for `src/transport-fake.ts` or a sibling fixture module),
    use `toProvenanceFixtureComment()` from `src/capture-format.ts` to
    generate the `PROVENANCE: CAPTURED-LIVE, ..., <date>` comment header —
    paste that unchanged above the real fixture body in a NEW pull
    request reviewed like any other change to this repo. (That PR is
    itself a separate, later piece of work — this rehearsal only produces
    the evidence for it, and is not required to open one.)

## What this rehearsal does NOT prove

Say this explicitly wherever you report the result, not just here:

- **Nothing about the fleet box, nothing about `wyzr cycle`'s own gate or
  wrong-box guard** — those are separate mechanisms with their own
  evidence, unexercised by this command.
- **One run is one run.** A single `confirmed` result establishes the
  write primitives work against this account and this device, once, on
  this date — not that every future write will succeed, not that a
  different plug model behaves identically, and not that propagation
  timing generalizes (the epic's own n=1 propagation measurement is
  explicitly NOT a latency budget).
- **A `confirmed` result here says nothing about `wyzr cycle`'s own
  recovery verdict** (reboot/daemon/fleet-pane checks) — this command
  performs no such composition; it stops at the plug's own read-back.
