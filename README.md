# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation + credentials + transport/auth + `devices list` +
`plug status`/`plug on`/`plug off` + the wedge-proof engine and `wyzr wedge
status` + the post-cycle recovery engine and `wyzr recovery status`.** This
repo ships the project skeleton, the redaction-proof output core, the typed
exit-code layer, gating CI, file-backed credentials loading
(`src/credentials.ts`), an injectable Wyze transport boundary with a real
HTTP implementation, a fake implementation, the auth session that logs in,
handles MFA, and holds/refreshes tokens, `wyzr devices list`, the three verbs
the whole product exists to provide (`wyzr plug status|on|off`), the gate
that decides whether the destructive power-cycle verb (a later story) is
ever allowed to run plus the read-only command that shows its reasoning, and
now the read-only command that answers "did the power cycle actually work?"
after that verb runs. See "Wyze transport and auth session", "`wyzr devices
list`", "`wyzr plug status|on|off`", "Live-device coverage", "`wyzr wedge
status`", and "`wyzr recovery status`" below.

**Three different machines are involved, and this matters for everything
below.** wyzr is installed and run from **the operator's own machine** (call
it the **manager machine**) — deliberately NOT the machine `wyzr` exists to
power cycle, and NOT the machine any given `wyzr` *process* (an agent,
CI, whatever built or is reading this repo) happens to be running on right
now. Those can be three genuinely different boxes. A last-resort lever must
not depend on any software running on the box it saves, so "where does wyzr
install" is answered **functionally** — the machine an operator runs it from
— never by naming a specific host. `~/.config/wyzr/credentials.json` (see
"Credentials" below) lives on the manager machine, whatever that happens to
be for you; this document intentionally never names a specific host, and
nothing in this repo should ever gain one.

## Install / usage

```sh
bun install
bun link   # or: bunx --bun github:brooswit-factory/wyzr#<ref> --help
wyzr --help
```

```
wyzr — a CLI for Wyze devices

Usage: wyzr [--json] <command> [args]

Commands:
  devices list           List the account's devices.
  plug status <device>   Report whether a plug is on/off, and reachable.
  plug on <device>        Turn a plug on (read back to confirm).
  plug off <device>       Turn a plug off (read back to confirm).
  wedge status            Report the wedge-proof engine's full evidence trail and verdict (read-only).
  recovery status --since <ISO-8601 timestamp>
                          Report post-cycle recovery evidence and verdict (read-only).
  cycle <device> [--dry-run]
                          Gated power cycle: off, wait, never-give-up on, then a recovery
                          verdict. DESTRUCTIVE. --dry-run is the only way to exercise this
                          verb's judgment without cutting power. See README's "wyzr cycle"
                          section before ever running this for real.
```

`--json` switches success output to machine-readable JSON on stdout and
error output to machine-readable JSON on stderr — see "Errors under
`--json`" below for the error shape, and "Two classes of non-zero exit
code" for why a "success" `--json` payload is not the same thing as "exit
code 0."

## Exit codes

Defined in `src/errors.ts` (`ExitCode`). `CliError` carries one of these;
`src/cli.ts` is the single boundary that maps a thrown error (a `CliError`
or otherwise) to the process's exit code. New codes may be added by later
stories — the numbers already assigned here never change or get reused.

| Code | Name                  | Meaning                                                |
| ---- | --------------------- | ------------------------------------------------------- |
| 0    | `ok`                  | Success.                                                 |
| 1    | `generic`             | Unexpected/uncategorized error.                          |
| 2    | `usage`               | Bad flags/arguments, or an unknown command.              |
| 3    | `credentials_invalid` | Credentials missing or invalid.                          |
| 4    | `not_found`           | Requested device/resource does not exist.                |
| 5    | `network`             | Transport/network failure — no response at all.          |
| 6    | `api_error`           | The API responded, but with an error.                    |
| 7    | `mfa_required`        | An MFA challenge could not be answered automatically.    |
| 8    | `ambiguous_device`    | `<device>` matched more than one device; never guessed between them. |
| 9    | `state_unknown`       | `plug status`: P3 and/or P5 could not be decoded. `plug on`/`off`: the write was accepted but the read-back could not be obtained or decoded — see "Two classes of non-zero exit code" below; this does NOT mean the write did nothing. |
| 10   | `write_contradicted`  | `plug on`/`off` only: the read-back succeeded and shows a state other than the one requested. **This does NOT mean the write failed** — see "Two classes of non-zero exit code" below; it is equally consistent with a write that succeeded and simply had not propagated by the time of this one, immediate, no-wait read. |
| 11   | `wedge_not_proven`    | `wyzr wedge status` only: the engine's verdict was NOT_PROVEN — see "`wyzr wedge status`" below. This is the default/refuse-by-default reading: a healthy box, a single silent instrument, a live direct path, or an unruled-out shared cause that never got the chance to matter all land here. |
| 12   | `wedge_inconclusive_by_shared_cause` | `wyzr wedge status` only: the verdict was INCONCLUSIVE_BY_SHARED_CAUSE — the local-connectivity control itself could not be read, so the shared-cause exclusion could not run. Distinct from 11 so a script can tell "not wedged" from "could not look." |
| 13   | `recovery_not_recovered` | `wyzr recovery status` only: the verdict was NOT_RECOVERED — the box affirmatively did not come back, affirmatively did not reboot, or some other check affirmatively failed. See "`wyzr recovery status`" below. |
| 14   | `recovery_fleet_half_restored` | `wyzr recovery status` only: the box itself is affirmatively back and rebooted, but the fleet came back with bare (un-flagged) agent processes present — the herdr-restore trap. wyzr detects and reports this; it does not fix it. |
| 15   | `recovery_inconclusive` | `wyzr recovery status` only: something load-bearing was looked at and could not be read, and nothing affirmatively failed — possible evidence about the box. Distinct from 16 so a script can tell "could not look" from "never configured." |
| 16   | `recovery_unconfigured` | `wyzr recovery status` only: nothing failed and nothing was unreadable — the only gaps are checks nobody ever pointed anywhere (an operator-fixable setup gap: an optional section — e.g. `recovery.daemon` — was left out of `config.json`). |
| 17   | `cycle_refused_by_gate` | `wyzr cycle` only: the wedge gate's verdict was NOT_PROVEN or INCONCLUSIVE_BY_SHARED_CAUSE and nothing overrode it. Produced whether or not `--dry-run` was passed — see "`wyzr cycle`" below. |
| 18   | `cycle_refused_by_wrong_box_guard` | `wyzr cycle` only: the wrong-box guard refused — either it affirmatively established this machine IS the configured target, or it could not affirmatively establish that it is not. Runs on every path, including `--force` and `--dry-run` — no escape hatch. |
| 19   | `cycle_refused_by_precondition` | `wyzr cycle` only: refused by the before-the-cut precondition (cloud unreachable, or the plug's P3/P5 not both readable) — the CAPABILITY `--force` can never override. |
| 20   | `cycle_dry_run_would_act` | `wyzr cycle --dry-run` only: every check cleared — a live run at this moment would have proceeded to cut power. Lets a script tell "dry run: would act" apart from a dry-run refusal (17/18/19). |
| 21   | `cycle_stranded` | `wyzr cycle` only, and the loudest code in this product: the OFF was attempted, the never-give-up ON restore ran to its bound, and the plug's own read-back never confirmed "on". NEVER reported as success. |
| 22   | `cycle_not_recovered` | `wyzr cycle` only: the plug confirmed the restore, but the composed recovery verdict was NOT_RECOVERED. |
| 23   | `cycle_fleet_half_restored` | `wyzr cycle` only: the composed recovery verdict was FLEET_HALF_RESTORED. Its own code rather than reusing 14 — see "`wyzr cycle`" below for why. |
| 24   | `cycle_recovery_inconclusive` | `wyzr cycle` only: the composed recovery verdict was INCONCLUSIVE. |
| 25   | `cycle_recovery_unconfigured` | `wyzr cycle` only: the composed recovery verdict was UNCONFIGURED. |
| 26   | `config_invalid` | The single configuration surface (`src/config.ts`'s `loadWyzrConfig()`, WYZR-20/WYZR-28): the config file is missing, unreadable (over-permissive directory or file mode), unparseable, has an unknown/missing/mistyped field, has a present-but-incomplete optional section, or configures the fleet plug and the safe plug as the same device. ONE code for all of these — see "Configuration" under `wyzr wedge status` below for why, mirroring `credentials_invalid`'s own precedent; `CliError.reason` carries the finer detail (`config_missing`, `config_file_mode`, `config_field_missing`, `config_plug_conflation`, ...). |
| 27   | `doctor_not_ready` | `wyzr doctor` only: at least one check affirmatively FAILED — see "`wyzr doctor`" below. |
| 28   | `doctor_inconclusive` | `wyzr doctor` only: nothing failed, but at least one attempted check could not be read. |
| 29   | `doctor_unconfigured` | `wyzr doctor` only: nothing failed and nothing was unreadable — the only gaps are things nobody ever pointed anywhere (no `config.json` at all, or an optional section left out). |

Codes 8/9/10 were added by `wyzr plug status|on|off` (WYZR-13); 11/12 were
added by `wyzr wedge status` (WYZR-17); 13/14/15/16 were added by `wyzr
recovery status` (WYZR-25); 17-25 were added by `wyzr cycle` (WYZR-19/
WYZR-27); 26 was added by the config file (WYZR-20/WYZR-28); 27/28/29 were
added by `wyzr doctor` (WYZR-29) — all appending only, never renumbering or
reusing an existing code. 0–7 are unchanged from earlier stories. `wyzr
cycle`'s own success (cycled and recovered) reuses exit `0`, by symmetry
with `recovery status`'s RECOVERED — `wyzr doctor`'s own READY verdict does
the same.

### Two classes of non-zero exit code

**Codes `2`/`3`/`4`/`5`/`6`/`8`/`26` are ERROR codes.** Something kept the
command from doing its job at all — `26` (`config_invalid`) joins this
class rather than the OUTCOME classes below: an invalid config means no
probe ever ran, exactly like an invalid credentials file (`3`). These are
thrown as a `CliError`, handled by `src/cli.ts`'s single error boundary,
and printed under `--json` as the `{"error": {...}}` envelope below, on
stderr.

**Codes `9`/`10` are OUTCOME codes, not error codes.** The command
*succeeded* at doing its job — it wrote (for `plug on`/`off`) or read (for
`plug status`) and is reporting exactly what it observed. It prints its
**normal, documented `--json` payload** (see "`wyzr plug status|on|off`"
below) to **stdout**, and returns the non-zero code — it never throws, and
`--json` mode never wraps a `9`/`10` result in the `{"error": {...}}` shape.
An error envelope would discard the very fields (`requested`,
`observedPower`, `verification`) that let an operator or a downstream
caller reason for itself about what happened; that is the reasoning this
split exists to preserve. A genuine transport failure on `plug status` —
nothing written, nothing observed — is still an ordinary error code (e.g.
`network`/`api_error`), never folded into `9`.

**Codes `11`/`12` are OUTCOME codes too, on the same reasoning.** `wyzr
wedge status` runs every configured probe and is reporting exactly what it
observed — a "not wedged" or "could not look" verdict is the command
*working*, not failing. It prints its normal, documented evidence-trail
payload (see "`wyzr wedge status`" below) to stdout and returns the code;
`--json` mode never wraps `11`/`12` in the `{"error": {...}}` shape either.
An error envelope would discard the entire evidence trail — the reasons,
per-instrument quiet durations, and direct-path results — which is exactly
the payload this command's whole reason for existing is to preserve.

**Codes `13`/`14`/`15`/`16` are OUTCOME codes too, on the same reasoning.**
`wyzr recovery status` runs every configured check and is reporting exactly
what it observed — NOT_RECOVERED, FLEET_HALF_RESTORED, INCONCLUSIVE, or
UNCONFIGURED are the command *working*, not failing. It prints its normal,
documented evidence-trail payload (see "`wyzr recovery status`" below) to
stdout and returns the code; `--json` mode never wraps any of these in the
`{"error": {...}}` shape either.

**Codes `17`-`25` are OUTCOME codes too, on the same reasoning — with one
exception.** A refusal (`17`/`18`/`19`), a would-act dry run (`20`), a
composed recovery outcome (`22`/`23`/`24`/`25`), and a stranded restore
(`21`) are ALL the command *working*, not failing — it evaluated the gate,
the wrong-box guard, and the preconditions (and, on a live run that
proceeded, performed the OFF/wait/ON sequence and the recovery check) and
is reporting exactly what happened. All of these print the normal,
documented evidence-trail payload (see "`wyzr cycle`" below) to stdout,
never the `{"error": {...}}` shape. **The one genuine usage error this verb
adds — `--force` without a satisfied confirmation, or `--force` with no
configured wrong-box target — is an ordinary Usage error (`2`)**, not a new
outcome code: it is "you invoked the CLI wrong," the same class as a
missing `<device>` argument, not a claim about the gate, the box, or the
plug.

**Codes `27`/`28`/`29` are OUTCOME codes too, on the same reasoning.** `wyzr
doctor` runs every check it can and is reporting exactly what it
observed — NOT_READY, INCONCLUSIVE, or UNCONFIGURED are the command
*working*, not failing. It prints its normal, documented evidence-trail
payload (see "`wyzr doctor`" below) to stdout and returns the code;
`--json` mode never wraps any of these in the `{"error": {...}}` shape
either.

**Neither `9` nor `10` is a claim that a write did nothing.** `9` on the
write path means the write was accepted by Wyze AND its resulting state
could not be read back — both halves matter; "state unreadable" is not
"the write did nothing." `10` means only that a single, immediate, no-wait
read-back disagreed with what was requested — indistinguishable, in one
read, from the change simply not having propagated yet. wyzr's own human-
readable text for both never claims the write itself failed; see
"`wyzr plug status|on|off`" below.

## Errors under `--json`

On any ERROR code (see "Two classes of non-zero exit code" above), `--json`
mode prints exactly one JSON value to **stderr** (never stdout) instead of
a prose message:

```json
{
  "error": {
    "code": "not_found",
    "exitCode": 4,
    "reason": "device_not_found",
    "message": "no such device"
  }
}
```

- `code` — the stable string name from the table above; switch on this,
  not the integer, so your code survives new codes being added later.
- `exitCode` — the same integer the process exits with, for callers that
  already track exit codes.
- `reason` — optional, finer-grained machine-readable detail beyond `code`
  (e.g. distinguishing which of several "not found" cases occurred), or
  `null` when the code alone is specific enough.
- `message` — a human-readable description. Never parse this for control
  flow; it can change wording between versions.

This is the **only** error shape in this CLI. `plug status`/`plug on`/
`plug off`'s `9`/`10` outcomes do NOT use it — see "Two classes of non-zero
exit code" above.

## The output core (security-critical)

Every terminal write in `src/` goes through `src/output.ts`
(`printHuman`, `printJson`, `printError`, `printJsonError`) — human and
`--json` output, stdout and stderr, both success and error paths, all
funnel through those four functions, and every one of them scrubs its
argument with `src/redact.ts`'s `redact()` before printing. There is no
fifth way to print.

`src/redact.ts` maintains a secret registry (`registerSecret`) — any value
registered there is scrubbed from all future output — plus a list of
generic credential-bearing shapes (`Authorization: Bearer <value>`,
`Authorization: <value>`, `X-API-Key:`, `Apikey:`, `Keyid:`, JSON
`"access_token"`/`"refresh_token"` fields) that get scrubbed even for a
value that was **never** registered, case-insensitively. Registering an
empty string, `undefined`, or `null` is a no-op — an unset credential must
never redact every character of every message. `resetSecretsForTesting()`
clears the registry between tests.

### Verifying no output bypasses it

Paste this to confirm nothing under `src/` writes to a std stream outside
`src/output.ts` (CI runs the equivalent check as a script —
`scripts/check-no-console.ts`, wired in as the `no-direct-console` job —
not this grep; the grep is for a human reviewer to double-check by hand):

```sh
grep -rnE '(console\.(log|error|warn|info|debug|trace)\s*\(|process\.(stdout|stderr)\.write\s*\(|Bun\.write\s*\(\s*(process\.(stdout|stderr)|Bun\.(stdout|stderr)))' src --include='*.ts' | grep -v '^src/output.ts:'
```

No output = clean. Any line printed is a violation.

## Credentials

`src/credentials.ts`'s `loadCredentials()` is the **only** way a Wyze
secret enters this process. It reads a single JSON file, validates it,
registers every secret value with the redaction registry (`src/redact.ts`)
before returning, and refuses to load a file (or containing directory)
that is readable or writable by anyone but its owner. There is no
credential flag on the CLI, of any kind, and no environment-variable
fallback for a secret — file-backed only.

**Nothing here has ever been exercised against a real Wyze account or
device.** This module has no transport, no HTTP, no MD5 hashing, and no
MFA handling — it only loads and types the values a later story's auth
call will use. Every unit test constructs its own temp directory and
passes an explicit `CredentialsEnv`; none of them touch the real `$HOME`
or `$XDG_CONFIG_HOME`, and the whole suite runs with zero credentials and
zero network.

### File location

`$XDG_CONFIG_HOME/wyzr/credentials.json` when `XDG_CONFIG_HOME` is set and
non-empty, else `$HOME/.config/wyzr/credentials.json`. The same directory
(`wyzrConfigDir()`, exported from this module and reused rather than
reimplemented) also holds `config.json` — the single configuration
surface for everything that is NOT a secret credential; see `wyzr cycle`'s
own "Configuration" section below for its full schema.

### File shape

A single JSON object:

```json
{
  "email": "you@example.com",
  "password": "your-wyze-account-password",
  "keyId": "your-developer-api-key-id",
  "keySecret": "your-developer-api-key-secret",
  "totpSecret": "your-totp-secret"
}
```

| Field        | Required | Meaning                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------ |
| `email`      | yes      | Wyze account email.                                                      |
| `password`   | yes      | Wyze account password (native Wyze password, not an SSO provider's — see `docs/wyze-api-findings-2026-09-02.md` §Q3 for why an SSO-only account fails auth). A later story sends it as `md5(md5(md5(password)))`, never raw — this module only carries it. |
| `keyId`      | yes      | Developer API key ID, from `developer-api-console.wyze.com`.             |
| `keySecret`  | yes      | Developer API key secret, from the same console.                        |
| `totpSecret` | no       | TOTP secret, only if the account has MFA enabled. Absent, `null`, or `""` (an empty string is treated identically to absent) when the account has none. |

Any field not in this table is rejected — this is deliberate: it is the
one place that would catch someone accidentally adding the SDK's separate,
non-user-specific app-identity key (see the ticket / the findings doc,
§Q3) to this file, which is a different task's concern and must not live
here.

Unknown-field and type/shape errors, a missing file, and malformed JSON
all exit on the dedicated `credentials_invalid` code (see the exit-code
table above) with a message naming the field or problem — **never**
anything about a secret's value (not a prefix, not a length, not a hash).

### File and directory mode

Both `credentials.json` and its containing directory must be readable and
writable by their owner only — `mode & 0o077` must be `0` for each
(no group or other bits). A looser mode on either is refused outright,
never warned-and-continued, with the exact fix in the error:

```sh
chmod 700 ~/.config/wyzr      # or $XDG_CONFIG_HOME/wyzr
chmod 600 ~/.config/wyzr/credentials.json
```

The directory is checked as well as the file: a directory writable by
another user on the box lets them replace the credentials file entirely
(or symlink it elsewhere), which a file-mode check alone cannot catch.

### Redaction

`password`, `keySecret`, and `totpSecret` are registered with
`src/redact.ts`'s secret registry before `loadCredentials()` returns —
every later `printHuman`/`printJson`/`printError`/`printJsonError` call
scrubs them automatically. `email` and `keyId` are **not** registered:
they are identifiers rather than secrets, and registering a short or
common string with a substring-matching redactor risks scrubbing
unrelated, legitimate output that happens to contain the same substring.

## Wyze transport and auth session

Everything that talks to Wyze goes through one injectable interface,
`WyzeTransport` (`src/transport.ts`): `login`, `submitMfa`, `refreshToken`,
`getObjectList`. Two implementations ship side by side, both first-class:

- `RealWyzeTransport` (`src/transport-http.ts`) — performs actual HTTP
  calls, implemented directly in TypeScript against the raw endpoints (no
  Wyze JS package dependency, per
  `docs/wyze-api-findings-2026-09-02.md` §Q6). Its HTTP-performing function
  is **injectable** (`fetchImpl`, defaulting to the global `fetch`), which
  is what lets its request construction and response handling be
  unit-tested with **zero network** — see `test/unit/transport-http.test.ts`,
  every case of which injects a fake `fetchImpl`.
- `FakeWyzeTransport` (`src/transport-fake.ts`) — serves canned envelopes,
  overridable per method per test.

`src/auth-session.ts`'s `WyzeAuthSession` is written against the
`WyzeTransport` interface only, never against either implementation
directly, so its login/MFA/refresh logic is fully exercised by
`test/unit/auth-session.test.ts` against the fake, with **zero credentials
and zero network**.

### The fake's responses are tiered by provenance, not all "synthetic"

`docs/wyze-api-findings-2026-09-02.md`'s explicit unknown #1 is that no
captured example of a real Wyze *device*-host response payload exists in
any (a)/(b)-tier source found during that research — that unknown still
stands for `get_object_list`/`get_property_list`/`set_property`. WYZR-15
closed a NARROWER unknown, though: the *auth* host's **error** shape needs
no account at all, only a well-formed request with placeholder credentials
(see `docs/wyze-no-credential-probing.md`) — so it has actually been
captured now.

Every fixture in `src/transport-fake.ts` is tagged, in its own doc
comment, `PROVENANCE: CAPTURED-LIVE <date>` (built from a real observed
response, one-time fields like a request id replaced with a fixed
placeholder) or `PROVENANCE: ASSUMED (tier (d)[, corroborated ...])` (no
real response of this shape has ever been observed — constructed from the
finding's description and/or a community-SDK source read).
`grep -rn "PROVENANCE: ASSUMED" src/` finds every belief in this repo that
has never been checked against the real API. A green test against an
ASSUMED fixture proves this repo's code matches this repo's own belief
about the Wyze API — **it is not, and must never be read as, evidence
about the real API.** A green test against a CAPTURED-LIVE fixture is
stronger, but still only as current as its capture date.

### Auth flow

`login()` sends, per WYZR-15's live-account measurement (RELAYED, not
observed directly by this repo's own authors — see "TWO response
envelopes" below for what that provenance means), which SUPERSEDED an
earlier, incorrect tier-(b) belief read from the community `wyze-sdk`'s
source:

- `email` — plain, from `credentials.json`, in the JSON body.
- `password` — **never raw**. Sent as `md5(md5(md5(password)))`
  (`src/wyze-auth-hash.ts`'s `wyzeTripleMd5`), MD5 applied three times in a
  chain, in the JSON body. This part of the pre-WYZR-15 belief was
  CONFIRMED correct — get it wrong and login fails with the same
  errorCode 1000 as a wrong password (see below), so there is no way to
  tell the two apart from the response alone.
- `keyid` / `apikey` — the user's own Developer API Key ID/Secret, from
  `credentials.json` (`keyId`/`keySecret`) — as **HTTP HEADERS**, not
  body fields. This is the correction: wyzr's pre-WYZR-15 shape sent
  these in the body instead, which the real auth host rejects outright
  (HTTP 400, errorCode 1000) even with perfectly correct credentials.

That is the WHOLE body — no `nonce` field. An earlier belief (tier (b),
inferred from the SDK's source, never itself measured) held that a fresh
nonce was required; WYZR-15's measurement showed the real, working login
body is exactly `{email, password}` and nothing else, so `nonce` — and
the `AuthSessionDeps.nonce`/injectable-clock machinery that generated one
— is retired outright, not merely unused.

The pre-WYZR-15 shape ALSO sent an `x-api-key` header on every call,
identifying the app itself — retired too; see "The app-identity key"
below for what replaced it, and only on the OTHER host.

### The app-identity key

**Retired for the auth host, replaced by something different (and
required) on the device host — read this section, don't assume it means
what the old heading implied.**

The finding (§Q3) originally described a **second, separate,
non-user-specific key**, sent as `x-api-key`, hardcoded into the
community SDK's own source to identify the calling app/library. wyzr
minted its own equivalent (`src/app-identity.ts`, now removed) rather than
copying the SDK's embedded value. The header is gone, not migrated — but
the two hosts are NOT in the same evidentiary state, and it matters which:
the relayed **auth-host** measurement enumerated the working login
request's *full header set* (`keyid`, `apikey`, `content-type`) — no
`x-api-key` among them — so "the working login doesn't carry it" is a
genuine observation. The relayed **device-host** measurement recorded a
*body* only; it never recorded that request's headers at all, in either
direction, so "no working device-host call carries this header" would
itself be exactly the kind of one-step-past-the-evidence claim this
section warns about below — this project does NOT claim that. The header
is retired for the device host as the defensible default (an unobserved
header nobody has evidence for is not something to keep sending on a
guess), not because any request was observed to work without it.

What the device host (`api.wyzecam.com`) ACTUALLY requires instead is a
much larger **"standard body"** merged into every call's JSON payload —
`sc`/`sv`/`app_ver`/`app_name`/`app_version`/`phone_id`/
`phone_system_type`/`ts` (`src/wyze-device-identity.ts`,
`deviceStandardBody()`). A request missing these fields is rejected
(`{"code":"1001","msg":"INVALID_PARAMETER"}`) even with a perfectly valid
access token. `sc`/`sv`/`app_ver`/`app_name`/`app_version` are, by every
visible signature, the community SDK's own static app identity — the
exact thing this project's root doc previously recorded a deliberate
choice NOT to lift. **State this precisely, per the ticket's own
retraction of an earlier overstatement**: MEASURED — the device host
ACCEPTED these static values, verbatim, on a request a bare
`{access_token}` body was rejected for. NEVER TESTED — whether a MINTED
identity in the same field slots would be refused. wyzr ships the static
values because they are the only ones ever shown to work, **not** because
minting was tried and failed — nobody has run that experiment, and it
would need the real device host this project has no access to. See
`src/wyze-device-identity.ts`'s header comment for the full record.

### MFA handling — and its limits

The finding establishes (tier (b)) that login can return a TOTP or SMS
challenge. `src/auth-session.ts` detects a challenge from the auth-host
response's own top-level shape (`mfa_options`, plus — as of WYZR-15's
correction — a TOTP verification id at `mfa_details.totp_apps[0].app_id`
or an SMS session id at `sms_session_id`; see
`src/wyze-auth-envelope.ts`'s `detectAuthMfaChallenge()`), checked
**before** any success/error interpretation, because neither the finding
nor the auth host's own measured shape establishes anything that
accompanies a challenge as reliably as `mfa_options`'s presence.

- **TOTP, with a `totpSecret` configured**: answered automatically.
  `src/totp.ts` implements RFC 4226 HOTP and RFC 6238 TOTP against
  `node:crypto` only, verified offline against RFC 6238 Appendix B's own
  published test vectors (`test/unit/totp.test.ts`) — one of the few
  pieces of this story provably correct rather than merely believed. An
  empty-string `totpSecret` is treated identically to an absent one (fixed
  in `src/credentials.ts`; see "Two items carried forward" below), so it
  correctly falls through to the "missing" case rather than misfiring.
- **TOTP, with no `totpSecret` configured**: a clear `mfa_required`
  (`ExitCode.MfaRequired`) error naming what happened and what to do.
- **TOTP, with an invalid (non-base32) `totpSecret` configured** (e.g. a
  password pasted into the wrong field by mistake): a clear
  `mfa_required` error naming the problem — with the offending character
  itself never echoed. `src/totp.ts`'s `base32Decode()` reports only the
  0-based position of an invalid character, never the character, because
  `src/redact.ts` matches whole registered strings, not one unregistered
  character of one — echoing it would leak a fragment of a secret straight
  past redaction. Covered by a dedicated test in `test/unit/totp.test.ts`
  and an end-to-end one in `test/unit/auth-session.test.ts`, both run
  red-first.
- **SMS**: wyzr has no way to receive or answer an SMS code. A clear
  `mfa_required` error, never a silent failure or a pretended-away branch.
- **An unrecognized challenge type**: same treatment — a clear error, not
  a guess.
- Exactly one challenge-and-answer round is attempted; a second challenge
  after answering the first is NOT retried (surfaces as a generic API
  error instead of looping).

**This entire path is, by construction, untested against reality.** The
finding's explicit unknown #2: whether the account that eventually gets
provisioned will hit MFA at all, and which kind, is unknowable until that
account exists. Beyond that, the exact wire-format field names this module
reads (`mfa_options`, `mfa_details.totp_apps[0].app_id`, `sms_session_id`)
and the MFA-answer endpoint/body shape (`submitMfa` re-POSTs to the login
endpoint — see `src/transport-http.ts`) are tier (d) — this author's own
inference — corroborated tier (b) by reading the community
`shauntarves/wyze-sdk` Python source directly (see
`src/wyze-auth-envelope.ts`'s header comment for exactly what was read and
when), but still not confirmed against any captured real payload. The
TOTP **math** is proven correct against a published standard; the
**plumbing** that detects and answers a real Wyze challenge has never run
against one.

### TWO response envelopes, not one — the WYZR-15 correction

Until WYZR-15, this repo believed one envelope shape held "on every call,
auth and device alike." **That was wrong**, and is documented as the root
cause it was in `docs/wyze-api-findings-2026-09-02.md`'s §Q3 correction.
Measured directly on 2026-09-10, with placeholder credentials, against
both real hosts:

- **The DEVICE host** (`api.wyzecam.com` — `getObjectList`/
  `getPropertyList`/`setProperty`, and `refreshToken` too, despite its name
  suggesting otherwise) answers `{"code": ..., "msg": ..., "data": {...}}`
  over HTTP 200, **even on error** (`src/wyze-envelope.ts`). This part of
  the original belief was correct — WYZR-15's own measurement (a
  `get_property_list` call with a placeholder token) upgraded it from tier
  (b) to tier (a) and changed nothing about it.
- **The AUTH host** (`auth-prod.api.wyze.com` — `login`/`submitMfa` only)
  answers something else entirely (`src/wyze-auth-envelope.ts`): its error
  shape is `{"description": ..., "errorCode": ..., "requestId": ...}` —
  **no `code`, `msg`, or `data` at all** — over **HTTP 400**, not 200.
  Every function that used to read `envelope.code`/`envelope.data` against
  a real auth-host response silently got `undefined` for all three: an MFA
  challenge was never detected, a successful login was never recognized as
  one, and `errorCode 1000` never reached the SSO-or-wrong-password
  message below — it fell through to a generic "code undefined" error
  instead. Traced through the merged source, this meant **wyzr most likely
  could not log in at all, even with perfect credentials** — not merely
  that one error message was unreachable.

The HTTP status signal is **inverted** between the two hosts (device:
always 200; auth: 400 on error) — so error detection cannot key on status
alone, and cannot key on body shape alone either, since the two hosts'
body shapes differ. It keys on **which host answered**: `login()`/
`submitMfa()` always interpret their response as a `WyzeAuthEnvelope`;
every other method always interprets its response as a `WyzeEnvelope`.
The auth host's SUCCESS shape (`access_token`/`refresh_token` at the TOP
LEVEL, not nested under `data`) has never been directly observed — no
account exists, none will be created — but is corroborated tier (b) by
reading the community `shauntarves/wyze-sdk` Python source directly; see
`src/wyze-auth-envelope.ts`'s header comment for exactly what that source
read established and what remains genuinely unknown.

Both envelopes share the same string-vs-number wire-type defensiveness.
The finding is explicit that the device host's success (`code == "1"`) is
a **string**, not the number `1` — a strict `=== 1` check would be
silently wrong — and gives `1000`/`2001` "without pinning their wire type
as carefully"; WYZR-15's own auth-host measurement showed `errorCode`
arriving as the **number** `1000`, not a string, so the same ambiguity
exists on both hosts. `wyze-envelope.ts`'s `normalizeCode()`/
`normalizeMsg()` coerce with `String(...)` **once**; `wyze-auth-envelope.ts`
REUSES `normalizeCode()`/`normalizeMsg()` for `errorCode`/`description`
rather than adding a second normalizer, so a wire value of the number
`1000` and the string `"1000"` are handled identically on **either** host.
This was verified red-first: see the PR body for the exact failing output
observed when `isSuccessEnvelope`/`isAuthInvalidCredentialsCode` were
each temporarily broken.

### The errorCode 1000 trap

`errorCode 1000` from the auth host covers **at least three** distinct,
indistinguishable-from-the-response-alone causes — WYZR-15's correction of
an under-count in this project's own earlier belief:

1. A genuinely wrong `email`/`password`/`keyId`/`keySecret`.
2. A Wyze account created via Google/Apple SSO, which has no Wyze-native
   password, so the triple-MD5 chain has nothing to hash (finding
   §Q3/§Q7).
3. A request the auth host could not read the login key from AT ALL — this
   project's own pre-WYZR-15 login request (keyid/apikey in the JSON body
   instead of headers) is a confirmed real example: it produced this exact
   errorCode with genuinely correct credentials.

`src/wyze-errors.ts`'s `wyzeInvalidCredentialsOrSsoOnlyError()` originally
named only the first two, on the belief that they were the only two —
**that message would have sent an operator to change a password that was
never the problem**, in exactly the (3) case this project itself
triggered. It now names all three and points at the fix for (2): open the
Wyze app → Account → Security and look for "Change Password" — if it is
not there, the account is SSO-only and needs a Wyze-specific password set
before wyzr can log in.

**This message was unreachable against the real API before WYZR-15** — a
well-formed `credentials.json` with placeholder credentials produced
`"Wyze API returned an error (code undefined)."`, exit `api_error` (6),
instead. Verified end-to-end through the CLI, both before and after the
fix, with a real (placeholder-credentialed) call to the live auth host —
see the PR body for the before/after transcript.

**What that before/after run proves, and what it does NOT.** A
placeholder-credentialed login is ALWAYS wrong credentials (cause 1 or
3 above) — errorCode 1000 cannot tell those two apart, which is exactly
this trap's own subject. So the after-run proves the **decode** is fixed
(1000 now correctly reaches this message and exit 3, instead of "code
undefined" and exit 6) — real and worth having — but it is **strictly
less** than proof the **request shape** is now correct, since a
STILL-malformed request would produce the identical observable result.
Only a login that actually SUCCEEDS — which needs a real account — can
tell those apart; see "Live-device coverage" below for what did and did
not get checked that way for this change.

### Token discipline

`login()`/`refresh()` (via `WyzeAuthSession`) authenticate once and hold
tokens in memory; nothing in this repo re-runs the password login per
call, per the finding's warning that the SDK's own maintainer calls that
pattern "deprecated due to issues with authentication rate limiting."

`getObjectList()` treats `code == 2001` / `msg == "AccessTokenError"` as
the **authoritative** signal a token is dead — not a clock-based timer —
per the finding's reduced-confidence token-lifetime numbers (§Q3, unknown
#3: the page stating ~2 day/~30 day/~1 year lifetimes returned HTTP 403 to
the researcher's fetch tool). On that signal, it refreshes and retries
**exactly once**; a second expiry immediately after a fresh refresh throws
`wyze_access_token_refresh_loop` rather than refreshing again — bounded
against infinite recursion, per the ticket's requirement. A refresh call
that itself fails (`wyze_refresh_failed`) never falls back to re-running
the password login automatically; a fresh `login()` is required.

**No automatic retry on the login endpoint, anywhere** — the finding names
login-endpoint rate limiting as a specific hazard (§Q5), and a retry loop
there is exactly the wrong reflex.

### Tokens are secrets, registered the moment they are received

Both `src/transport-http.ts` (the instant a real HTTP response's JSON is
parsed, unconditionally — even on a non-success envelope, since the
finding warns reverse-engineered APIs "routinely include tokens and
account identifiers" beyond what was asked for) and
`src/auth-session.ts` (the instant tokens are extracted from a successful
envelope, regardless of whether they arrived via `login`, the MFA path, or
`refresh`) register `access_token`/`refresh_token` with
`src/redact.ts`'s registry before returning to any caller. This was also
verified red-first — see the PR body. The triple-MD5 password hash
(`src/auth-session.ts`'s `hashedPassword()`) is registered the same way,
the moment it is computed — it is password-**equivalent** (exactly what
authenticates on the wire), not merely password-derived. No raw API
response is ever printed wholesale on any path. This story (WYZR-11) itself
added no `printHuman`/`printJson` call — the first one lands with
`wyzr devices list` below, which projects onto an explicit field allowlist
rather than ever printing `getObjectList()`'s raw `data` (see "`wyzr devices
list`" below for how).

### Two items carried forward from WYZR-10's review

- **`.gitignore`**: widened from the literal `credentials.json` to
  `*credentials*.json` — keeps every `.ts` source file visible while also
  catching `wyze-credentials.json`, `credentials-prod.json`,
  `credentials.json.bak`, etc. A backstop, not the control.
- **Empty-string `totpSecret`**: `src/credentials.ts`'s
  `optionalStringField()` now treats `""` identically to absent/`null` —
  fixed at the source (rather than requiring every caller to re-apply a
  falsy check) so the exported type's optionality means what it says. A
  naive `!== undefined` check downstream would otherwise read `""` as
  "configured" and misfire the MFA/TOTP path above.

## `wyzr devices list`

Lists the account's devices — the first command a human actually runs, and
the first output surface a downstream automation epic parses
programmatically. Its `--json` shape is a **published interface**, not a
convenience: see "The `--json` contract" below before changing any field.

```sh
wyzr devices list           # human-readable
wyzr devices list --json    # machine-readable, stable shape
```

Wiring: `src/cli.ts`'s `dispatchDevices()` loads credentials
(`loadCredentials()`), constructs a real transport (`RealWyzeTransport`),
logs in (`WyzeAuthSession.login()`), calls `getObjectList()`, and hands the
raw response to `src/devices.ts`'s `projectDeviceList()` before printing.
**Every step of that pipeline is exercisable with zero credentials and zero
network** against `FakeWyzeTransport` and fixture credentials —
`test/unit/cli-devices.test.ts` does exactly that; `src/cli.ts`'s own
`loadCredentials()`/`RealWyzeTransport` call sites are injectable
(`DevicesDispatchDeps`) for the same reason `fetchImpl`/`CredentialsEnv` are
elsewhere in this repo, and are exercised with the injection substituted,
never for real, anywhere in this repo's test suite.

### Field allowlist, not a raw dump — the hardest rule in this command

`src/devices.ts`'s `projectDeviceList()` builds each output row by **naming
every field it exposes**, one at a time (`mac`, `product_model`, `nickname`,
`conn_state`) — it never spreads Wyze's raw per-device object and deletes
what it doesn't want. A denylist silently leaks whatever field the API adds
tomorrow that nobody anticipated today, and
`docs/wyze-api-findings-2026-09-02.md` warns reverse-engineered APIs
"routinely include tokens and account identifiers" beyond what was asked
for — this repo is **public**, so anything printed here (including in a CI
log) is public. `test/unit/devices.test.ts`'s "allowlist, not denylist"
test feeds the projection a device entry carrying `access_token`,
`refresh_token`, and `user_id` fields and asserts none reach the output;
`test/unit/cli-devices.test.ts` does the same at the full print-output
level with unregistered, non-token-pattern account-identifier field names
(`user_id`/`home_id`) specifically so the assertion exercises this
allowlist and not `src/redact.ts`'s separate generic-shape backstop. Both
were run red-first — see the PR body for the exact output observed with the
projection temporarily switched to a spread.

### No error or diagnostic message ever reproduces a field's value

Per the ticket's hardest new rule (added after WYZR-11 shipped a base32
decoder that printed one character of a user's password into a live error):
any diagnostic this command emits about a malformed field may name **which
field** and **what was expected**, and may report a **type**, but never any
part of the field's actual value — not the whole value, not a prefix, not a
single character. `src/devices.ts`'s `fieldNote()` reports only
`typeof`/`"array"`/`"null"`/`"undefined"`, mirroring `src/totp.ts`'s
`base32Decode()` (which reports only a character's position, never the
character). `test/unit/devices.test.ts`'s "malformed-field notes never
reproduce the field's value" tests feed a field a token-shaped string of
the wrong type and assert no part of it (not even an 8-character prefix)
appears in the resulting diagnostic — run red-first against a version of
`fieldNote()` that interpolated the raw value; see the PR body for the
exact red output observed.

### Malformed/unexpected data: a partial row with a marker, never a crash, never a silently dropped device

Per the ticket's requirement to choose and defend a strategy: a single
device entry with a missing or wrong-typed field **never drops that row and
never crashes the whole command** — it becomes a partial row (`mac`/`model`
`null`, a fallback `name`, `isPlug: false`, `state: "unknown"` as
applicable) with a fragment-safe `note` describing which field(s) were off.
**An emergency operator must never have their actual plug silently vanish
from the list because one field on it came back oddly shaped** — that
failure mode is worse than showing an imperfect row. Only a response that
is not shaped like a device list AT ALL (`data` isn't an object, or has no
`device_list` array) is a hard failure — `ExitCode.ApiError`,
`wyze_device_list_malformed` — because at that point there is nothing
per-row left to salvage. `"It never came up in tests" is not a defence` per
the ticket, and it doesn't apply here regardless: every case above
(missing field, wrong type, non-object entry, non-array `device_list`) has
its own test in `test/unit/devices.test.ts`.

### Plugs are marked, not filtered — and why

Every device is listed; a plug is marked `[PLUG]` in human output and
`isPlug: true` in `--json`, everything else `[?]` / `isPlug: false`.
**Filtering was deliberately rejected.** `isPlug` is computed against
`src/devices.ts`'s `KNOWN_PLUG_MODELS` — a small, explicitly-labeled,
**incomplete** set (currently just `"WLPP1"`, matching the model
`src/transport-fake.ts`'s own synthetic plug already uses) that is this
project's own inference (tier (d)), not sourced from
`docs/wyze-api-findings-2026-09-02.md`, which documents no model-code table
at all. A filter-by-default design built on this same incomplete list would
risk **hiding an operator's actual plug** behind an unrecognized model
code — unacceptable for a tool whose entire purpose is finding the plug
that reboots a wedged box. Marking never hides a device; `isPlug: false`
means "not recognized," never "confirmed not a plug."

### Online/offline state — an explicit, documented inference

`state` (`"online"` / `"offline"` / `"unknown"`) is derived from a
`conn_state` field (`1`/`"1"` → online, `0`/`"0"` → offline, anything else →
`"unknown"`) that this project **infers** `get_object_list` carries at the
device-list level. **This is NOT confirmed by the finding** — its explicit
unknown #1 is that no real `get_object_list` response has ever been
observed in any tier (a)/(b) source, and it documents no field names for
this call at all. This is deliberately **distinct from the `P5`
(reachability) property**, which the ticket's scope defence excludes
entirely (a separate `get_property_list` call, belonging to a later story):
`conn_state` is this project's guess at a coarser, device-list-level
connectivity signal returned by the one call this command makes, not a
request for `P5`. Expect every device's `state` to read `"unknown"` against
a real account until someone corrects the field name against a live
response — that is the honest, most likely outcome, not a bug.

### The `--json` contract

```json
{
  "schemaVersion": 1,
  "devices": [
    {
      "mac": "AB12CD34EF56",
      "model": "WLPP1",
      "name": "Garage Plug",
      "isPlug": true,
      "state": "online",
      "note": null
    }
  ]
}
```

| Field                | Type                                   | Always present? | Meaning                                                                                   |
| -------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `schemaVersion`      | `number`                                 | yes               | Bump on any field being added, removed, renamed, or changing meaning. A consumer should switch on this, not on which fields happen to exist. Currently `1`. |
| `devices`             | `array`                                  | yes               | One entry per device Wyze's account returned, in the order `get_object_list` returned them. Never filtered — see "Plugs are marked, not filtered" above. |
| `devices[].mac`       | `string` or `null`                       | yes (may be `null`) | The identifier device-control calls key on (paired with `model`), per the finding's Q4 table. `null` means this row's raw `mac` field was missing or not a non-empty string — the row cannot yet be acted on by a later command. |
| `devices[].model`     | `string` or `null`                       | yes (may be `null`) | The device's `product_model`. `null` on the same malformed-field basis as `mac`. |
| `devices[].name`      | `string`                                  | yes, never blank  | The device's `nickname`, or the literal placeholder `"(unnamed device)"` (or `"(malformed device entry)"` for a non-object entry) when missing/malformed. |
| `devices[].isPlug`    | `boolean`                                 | yes               | `true` only if `model` matched this project's own incomplete `KNOWN_PLUG_MODELS` set. `false` means "not recognized," **never** "confirmed not a plug" — see "Plugs are marked, not filtered" above. Do not treat `false` as proof of anything. |
| `devices[].state`     | `"online"` \| `"offline"` \| `"unknown"`  | yes               | See "Online/offline state" above — an explicit, undocumented-by-the-finding inference. Expect `"unknown"` against a real account until corrected. |
| `devices[].note`      | `string` or `null`                       | yes (usually `null`) | `null` on a clean row. Otherwise names which field(s) were malformed and what type was expected — **never any part of the field's actual value** (see "No error or diagnostic message ever reproduces a field's value" above). |

Consumers should treat an unrecognized future field as ignorable (this
command will only ever ADD fields within a `schemaVersion`, never repurpose
one) and should not assume `devices` is non-empty, or that any two `mac`
values are distinct beyond what Wyze itself guarantees (unverified against
reality — see below).

### Errors

`devices list` maps every failure onto the exit-code table above:
credentials problems and Wyze auth failures surface with their existing
codes from `src/wyze-errors.ts` (`credentials_invalid`, `mfa_required`,
etc.); a response that isn't shaped like a device list at all surfaces
`api_error` / `wyze_device_list_malformed` (see "Malformed/unexpected data"
above). `--json` mode's error path is the same documented
`{"error": {...}}` shape as every other command — no separate JSON error
mechanism was invented.

### This command has never been exercised against a real Wyze account or device

Every path `wyzr devices list` takes — login, `getObjectList()`, and this
command's own field allowlist, plug-recognition list, and connectivity-field
guess — is, like everything else in this repo, unverified against reality.
A green test suite here proves this code matches this project's own belief
about the Wyze API's shape; it **cannot** prove that belief is correct. See
"Live-device coverage" immediately below for the full statement this
applies to.

## `wyzr plug status|on|off`

The three verbs `wyzr` exists to provide (WYZR-13): report whether a plug
is on or off and reachable, and turn it on or off — each with a mandatory
`<device>` argument (a device's `mac`, or its `name`, both resolved through
`devices list`'s own projection — see "Device resolution" below).

```sh
wyzr plug status "Garage Plug"      # human-readable
wyzr plug status AB12CD34EF56 --json
wyzr plug on "Garage Plug"
wyzr plug off AB12CD34EF56 --json
```

Wiring: `src/cli-plug.ts`'s `runPlugStatus()`/`runPlugWrite()`, on the same
injectable pattern as `wyzr devices list` (`src/cli.ts`'s `dispatchPlug()`
supplies `loadCredentials()`/`RealWyzeTransport` for real; every test in
this repo supplies `FakeWyzeTransport` and fixture credentials instead —
zero credentials, zero network, throughout `test/unit/plug.test.ts`,
`test/unit/device-resolve.test.ts`, and `test/unit/cli-plug.test.ts`).

### Why this exists, and the two failure modes it exists to prevent

A downstream, safety-critical epic reads `plug status`'s output to decide
whether to power-cycle a live server, and calls `plug on`/`plug off` to
actually do it. Two collapses are unacceptable here, and this command's
entire design is built around refusing both:

1. **"Off" and "I could not determine the state" must never be conflated.**
   `P3` alone (the plug's power PID) cannot tell "off" apart from
   "unreachable" — that is what `P5` (reachability) is for. See "Device
   state: P3/P5 decoding" and "`plug status`'s off-vs-unknown rule" below.
2. **A disagreeing read-back after a write must never be reported as "the
   write failed."** It is equally consistent with a write that succeeded
   and simply had not propagated by the time of one, immediate, no-wait
   read. See "Write verbs: read-back policy" below.

### Device resolution — never guess

`<device>` is matched against `devices list`'s projection (`src/devices.ts`
`DeviceRecord[]`, via `src/device-resolve.ts`'s `resolveDevice()`) by:

- **`mac`, case-insensitive, EXACT match only**, or
- **`name`, case-insensitive, EXACT match only.**

**No prefix, fuzzy, or substring matching anywhere.** A near-match is a
`not_found`, never a guess. Two or more devices matching — including the
case where the argument matches one device's `mac` AND a **different**
device's `name` — is `ambiguous_device` (exit `8`), never a silent
mac-wins precedence; the error lists every match's `mac`/`model`/`name` so
the operator can retry unambiguously. Zero matches is `not_found` (exit
`4`). A device that resolves to exactly one match but whose projected
`mac` or `model` is `null` (`devices list`'s own partial-row case) cannot
be addressed by a property call — a clear error names which field was
missing; wyzr never sends a property request with a null field in it.
`test/unit/device-resolve.test.ts` covers all of the above, including the
mac-matches-one/name-matches-another ambiguity as its own dedicated test.

### Device state: P3/P5 decoding — a closed, boolean-rejecting whitelist

The finding's §Q4 originally described `P3` (power) and `P5`
(reachability) as both wire-encoded as an **integer**, `0` or `1` — read
from the community `wyze-sdk`'s own internal Python type declaration.
**WYZR-15's live-account measurement CORRECTED this**: a real
`get_property_list` read-back showed both wire-encoded as the **STRING**
`"1"`/`"0"` — the SDK's `int` typing describes its own Python-side
representation, not what actually crosses the wire. `src/plug.ts`'s
`decodeP3()`/`decodeP5()` accept **exactly** the string `"1"`/`"0"` (the
CONFIRMED wire form) and the number `1`/`0` (kept, defensively, from the
original belief — harmless to keep tolerating on READ). **Everything
else, including a native JSON `true`/`false`, decodes to `"unknown"`
(`P3`)/`null` (`P5`) — REJECTED, never helpfully coerced.** A boolean is
precisely the silently-wrong wire assumption the finding warns about;
degrading loudly to "unknown" on a wrong guess about the wire type is safer
than a confident misread. `test/unit/plug.test.ts` ships a dedicated
boolean-rejection test for each, run red-first (see the PR body for the
actual red output observed when `decodeP3`/`decodeP5` were temporarily
changed to coerce `true`/`false`).

The WRITE side did not get the same luck: `wyzr` previously sent `P3` as a
bare JSON integer under the field name `value` — WYZR-15's measurement
showed the real `set_property` call needs the field named **`pvalue`**,
carrying a **STRING** (`"1"`/`"0"`), and REJECTS the old shape outright.
`src/transport.ts`'s `SetPropertyRequest.value` is now typed `"0" | "1"`,
a string literal union — sending a number or boolean is a compile error,
not just a runtime mistake to catch in review, the same discipline the
read side has always had.

`src/plug.ts`'s `readPlugState()` reads `P3` and `P5` out of a
`get_property_list` response **independently of one another — reachability
is NEVER inferred from `P3`.** A response that is not shaped the way this
project expects (`data.property_list` as a list of `{pid, value}` entries —
this project's own inference; see the module's top comment, and ticket item
7's "recoverable parse error, never a silent misread") never throws; it
resolves to an unknown/undecodable reading instead, with a fragment-safe
`note` (field name and value TYPE only — never any part of the value
itself, same rule as `src/devices.ts`'s `fieldNote()`).

### `plug status`'s off-vs-unknown rule

`plug status` exits `0` **only when BOTH `P3` and `P5` decode.** If either
is `"unknown"`/`null`, it exits `state_unknown` (`9`) instead, and **the
human-readable output never prints a bare "on"/"off"** — it prints
`STATE UNKNOWN` naming which of power/reachability could not be determined,
with an explicit disclaimer that this is not the same as "off." Rationale:
with `P5` undetermined, a `P3` of `0` cannot be confidently called "off"
rather than a stale or unreachable reading — the off-vs-unknown distinction
is the entire reason `P5` is read at all. The `--json` output states
precisely which of the two was undetermined (`power`/`reachable`
individually) even though the exit code alone is coarse. A `P5` that
decodes to `false` (confirmed unreachable) is still a **decodable** value,
not an "unknown" one — it does not by itself force `state_unknown` if `P3`
also decoded — but human output still flags it (`"UNREACHABLE — this
reading may be stale"`) rather than reporting the pairing silently.
`test/unit/plug.test.ts` and `test/unit/cli-plug.test.ts` both ship a
dedicated red-first test for this rule (see the PR body for the actual red
output observed when the known/unknown branch was collapsed to always
report a confident state).

### Write verbs: read-back policy, and what the outcome codes may claim

Each of `plug on`/`plug off`: performs `set_property` (`P3 = 1` for on,
`P3 = 0` for off — sent as a **bare JSON integer**, never a boolean or a
string; `SetPropertyRequest.value`'s own type, `0 | 1`, makes a boolean a
compile error), then performs **exactly ONE immediate `get_property_list`
read of `P3` and `P5`.** No sleep, no polling, no retry loop, no timer of
any kind, anywhere in this path. Two reasons: the finding names
login-endpoint rate limiting as a specific hazard and this repo's transport
is deliberately retry-free elsewhere too; and a real-timer-driven poll
would make this suite's tests non-deterministic.

Three outcomes, from comparing the read-back against what was requested:

- **`confirmed`** — the read-back's `P3` matches what was requested. Exit
  `0`.
- **`unconfirmed`** — the read-back could not be obtained (the
  `get_property_list` call itself threw — CAUGHT here, never left to
  surface as a bare, uncaught transport error, because that would hide
  that the write was already accepted) or `P3` came back undecodable/
  absent. Exit `state_unknown` (`9`).
- **`contradicted`** — the read-back succeeded and shows a `P3` value other
  than the one requested. Exit `write_contradicted` (`10`).

**The one thing `set_property` itself failing (throwing before any write
was accepted) is NOT: an outcome.** That propagates as a normal error
(`network`/`api_error`/etc, per "Two classes of non-zero exit code" above)
— nothing was written, so there is no confirmed/unconfirmed/contradicted
outcome to report.

**What exit `10` — and `9` on the write path — are and are NOT allowed to
claim**, per the story epic's explicit review of this design:

- **Exit `10` means "the read-back at this instant did not agree with the
  write." It does NOT mean "the write failed."** wyzr cannot distinguish
  propagation lag on a write that actually succeeded from a write that had
  no effect — a single immediate read cannot tell those apart — so `10` can
  fire on a write that genuinely worked. A caller that reads `10` as "the
  write failed" and acts again on an already-changed plug causes real harm;
  this is the same shape as "unknown misread as off," one layer up. wyzr's
  human-readable text for `contradicted` therefore reports only what was
  observed (a disagreement) and explicitly never says the write failed.
- **Exit `9` on the write path means the write WAS accepted AND its
  resulting state could not be read — both halves, always.** "State
  unreadable" is not "the write did nothing"; wyzr's human-readable text
  says so plainly, never just one half.
- `test/unit/plug.test.ts` ships a dedicated test asserting this wording
  rule directly (not just the exit code) — it fails if `contradicted`'s
  formatter ever starts describing the write itself as failed.

### The `--json` contract

Its own exported `PLUG_SCHEMA_VERSION` (`src/plug.ts`), starting at `1`,
following `DEVICE_LIST_SCHEMA_VERSION`'s precedent. **Additive-only** — a
downstream safety-critical epic parses this; fields may be added within a
schema version, never renamed or removed.

`plug status`:

```json
{
  "schemaVersion": 1,
  "command": "plug status",
  "device": { "mac": "AB12CD34EF56", "model": "WLPP1", "name": "Garage Plug" },
  "power": "on",
  "reachable": true,
  "note": null
}
```

`plug on` / `plug off`:

```json
{
  "schemaVersion": 1,
  "command": "plug on",
  "device": { "mac": "AB12CD34EF56", "model": "WLPP1", "name": "Garage Plug" },
  "requested": "on",
  "result": "confirmed",
  "observedPower": "on",
  "reachable": true,
  "verification": { "readBacks": 1, "waitedMs": 0 },
  "note": null
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `power` / `observedPower` | `"on"` \| `"off"` \| `"unknown"` | Same three-value vocabulary on both commands. `"unknown"` is a first-class value — never `null`, never omitted, never conflated with `"off"`. |
| `reachable` | `true` \| `false` \| `null` | `null` for undetermined, mirroring how the error contract already uses `null` for "nothing finer to say." |
| `result` (write only) | `"confirmed"` \| `"unconfirmed"` \| `"contradicted"` | See "Write verbs: read-back policy" above. |
| `verification` (write only) | `{ readBacks: number, waitedMs: number }` | Always `{ readBacks: 1, waitedMs: 0 }` in this codebase (decision (D) forbids any retry/wait) — machine-readable proof of that fact, not an assumption a caller has to trust. Lets a caller decide FOR ITSELF whether to re-read on its own schedule to rule out propagation lag; that decision is never wyzr's to make. |
| `note` | `string` \| `null` | `null` on a clean reading. Otherwise names which field(s) were undecodable/malformed and what TYPE was expected — never any part of the actual value (same rule as `devices list`'s `note`). |

Errors (exit codes `2`/`3`/`4`/`5`/`6`/`8`) use the existing
`{"error": {...}}` shape from "Errors under `--json`" above — no second
error shape was invented. Outcomes (`9`/`10`) print the shapes above to
stdout and return the code — see "Two classes of non-zero exit code".

### Allowlist projection, same rule as `devices list`

`src/plug.ts` builds its output by naming each field it exposes — `pid`/
`value` out of `get_property_list`'s response — never by spreading the raw
API object. The repo is public and reverse-engineered responses routinely
carry tokens/account identifiers per the finding; an unexpected wrapper key
in a `get_property_list` response is parsed defensively (see "Device
state" above) and never printed wholesale.

### The fake fixture can express ONLINE, OFFLINE, and UNKNOWN

`src/transport-fake.ts`'s `fakeGetObjectListEnvelope()` originally (WYZR-6)
had no `conn_state` field at all, so every device it produced projected as
`state: "unknown"` — correct behavior (the projection never guesses), but
it meant this repo's own happy-path fixture could never exercise the
online/offline distinction this story depends on getting right. It now
takes an array of per-device overrides (`FakeDeviceListEntry`), with
`FAKE_PLUG_ONLINE`/`FAKE_PLUG_OFFLINE`/`FAKE_PLUG_STATE_UNKNOWN` presets;
`fakePropertyListEnvelope(props)` and `fakeSetPropertyEnvelope()` are new
siblings for `get_property_list`/`set_property`. Every one of these is
tagged `PROVENANCE: ASSUMED` in its own doc comment (see "The fake's
responses are tiered by provenance" above) — constructed from the
finding's description of the shape, never a capture of real Wyze traffic.

### This command has never been exercised against a real Wyze account or device

`plug status`, `plug on`, and `plug off` — the P3/P5 decode rules, the
`get_property_list`/`set_property` request and response shapes, and the
device-resolution logic layered on `devices list`'s own unverified field
names — are, like everything else in this repo, unverified against
reality. A green suite here proves this code matches this project's own
belief about the Wyze API's shape; it **cannot** prove that belief is
correct. Proving it would require a provisioned Wyze account with a real
plug and a single live run of all three verbs, which would close: whether
`P3`/`P5` really are present and int-encoded on this account's actual
hardware/firmware generation (finding §Q4's own open "WHAT IS P7?"
caveat), the real `get_property_list`/`set_property` request and response
field names (finding's explicit unknown #1), and whether a `set_property`
write is ever reflected fast enough for a single immediate read-back to
observe it at all (closing decision (D2)'s propagation-lag question in
the other direction, for the first time). See "Live-device coverage"
immediately below for the full statement this applies to.

## Live-device coverage

**Nothing in this repo has ever been exercised against a real Wyze
ACCOUNT or DEVICE, and that remains true after WYZR-15.** What changed:
WYZR-15 made a HANDFUL of deliberate, manual, placeholder-credentialed
calls to the real `auth-prod.api.wyze.com` (login) and `api.wyzecam.com`
(`get_property_list`) hosts — see `docs/wyze-no-credential-probing.md` —
specifically to observe their **error** envelope shapes, which need no
account at all. That is real coverage of those error shapes (now tier
(a); see `src/wyze-envelope.ts`/`src/wyze-auth-envelope.ts`'s header
comments) and is the reason `wyzeInvalidCredentialsOrSsoOnlyError()` is
reachable at all now (see "The errorCode 1000 trap" above). It is NOT
coverage of anything requiring a real account: no successful login has
ever been observed (the auth host's SUCCESS/MFA shapes stay tier (d),
corroborated tier (b) by a source read, never measured); `src/totp.ts`'s
math is proven against RFC 6238's own vectors but has never answered a
real challenge; `src/app-identity.ts`'s minted key has been SENT (as part
of every probe above) but whether Wyze actually HONORS a value it never
issued remains unverified, since every probe so far has failed for an
unrelated reason (bad credentials) before that could be distinguished;
and the token lifetimes and refresh behavior are only as documented in
the finding, at reduced confidence, never observed directly.

**Neither `wyzr devices list` nor `wyzr plug status|on|off` adds any
exception to any of this.** `devices list`'s `mac`/`product_model`/
`nickname` field names, its `conn_state` online/offline-inference field
name, and its `KNOWN_PLUG_MODELS` plug-model list are this project's own
inference (tier (d) at best), never confirmed against a real
`get_object_list` response — the finding's explicit unknown #1 is that no
such response has ever been captured in any tier (a)/(b) source. Expect,
specifically: every device's `state` to read `"unknown"` until
`conn_state`'s field name is corrected against a live account; a real plug
with an unrecognized model code to show `isPlug: false` until
`KNOWN_PLUG_MODELS` is corrected; and `mac`/`model` to read `null` if the
real field names differ from `mac`/`product_model`. None of these are bugs
in the sense of failing this repo's own test suite — the suite tests this
code against its own synthetic fixtures, which is exactly the limitation
this section exists to name.

**`plug status`, `plug on`, and `plug off` carry the same unverified
status, one layer further in.** `src/plug.ts`'s `get_property_list`/
`set_property` request field names (`target_pid_list`, `mac`, `model`,
`pid`, `value`) and its assumed response shape (`data.property_list` as a
list of `{pid, value}` entries) are this project's own inference by
analogy with `get_object_list`'s own `device_list` wrapper — never
confirmed against a real response, because none exists in any tier (a)/(b)
source (finding's explicit unknown #1, again). `P3`/`P5` themselves are
tier (b) — read from the actively-maintained `wyze-sdk`'s own source — but
whether THIS project's specific plug hardware/firmware exposes exactly
that PID set is unverified (finding §Q4's own open "WHAT IS P7?" caveat on
its reference source). And decision (D2)'s propagation-lag question — does
a real `set_property` write show up in an immediate read-back, or does it
take measurable time to propagate — is **unverified in both directions**:
this repo has never observed either a real confirmation or a real
contradiction. A provisioned account with a real plug, and a single live
run of all three verbs, would close: whether the request/response field
names above are right, whether this hardware's PID set matches, and
whether one immediate read-back is fast enough to typically observe a
write at all.

Every path in this repo — including `wyzr devices list` and
`wyzr plug status|on|off` end to end — is exercisable against
`FakeWyzeTransport` with no credential present at all — that is the
design, not a limitation — but a green suite here proves this code matches
this repo's own belief about the Wyze API, and **cannot** tell you that
belief is wrong. A green CI badge reflects the scaffold and this story's
logic (typecheck/lint/test/coverage/no-direct-console), not hardware or
live-API coverage. Later stories that add real device interaction are
expected to update this section — a green badge must never be read as
implying hardware or a real account has been touched until it says so here
explicitly.

## `wyzr wedge status`

The wedge-proof engine (WYZR-17) and its read-only CLI surface — the thing
that decides whether the destructive power-cycle verb (a later story,
`wyzr cycle`) is ever allowed to run, plus a command that shows its
reasoning. **This command cannot switch a plug, and is not capable of it —
see "Structurally read-only" below.**

```sh
wyzr wedge status           # human-readable, the full evidence trail
wyzr wedge status --json    # machine-readable, stable shape
```

### Why this exists

Two real incidents, eight days apart, both ended the same way — a human
walking to a room and pulling the cord by hand — from two different
proximate causes (a total freeze, then an OOM-driven thrash). The thing
being detected is not one failure signature; it is "the box is unreachable
and not coming back," which several distinct faults can produce. See the
WYZR-17 ticket for the full, dated account this design is built from
(relayed history, not independently re-measured by this repo).

**The stakes are no longer hypothetical.** As of 2026-09-10, the fleet
box's plug has been named and confirmed by an actual hand-run (read, off,
on, read-back, box booted). From that point on, this gate is the only
thing standing between a mistaken automated judgement and a fleet-wide
outage in which every in-flight agent turn everywhere dies with no drain
and no undo. That is why every design choice below leans toward refusing.

### The proof standard

A wedge is **PROVEN** only when ALL of these hold:

1. **At least two INDEPENDENT outside instruments are silent together.**
   "Outside" means observed from somewhere other than the suspect box.
   Independent means their silence is not attributable to one shared
   cause — see "The independence trap" below; this is the hardest rule
   here and the one most likely to be gotten wrong.
2. **The local-connectivity control was successfully read and reports
   healthy.** This is an unconditional PRECONDITION of PROVEN once two
   instruments are silent — never merely a tiebreaker that only matters
   for instruments that happen to declare a shared dependency. See "The
   independence trap" and "The local-connectivity control" below for why.
3. **Every configured direct path is confirmed dead.** ssh and tunnel
   ping today — see "Direct paths" below for what "confirmed dead"
   actually requires.

**One instrument is never enough.** A single silent probe is a network
blip, not a wedge. **Control-plane liveness never counts as either
instrument, and can never flip a PROVEN verdict to refused** — see
"Control-plane: recorded, structurally powerless" below.

**An affirmatively `"alive"` direct path outranks rule 2 above (WYZR-23).**
Rule 2's justification — a broken local connection makes every instrument
go quiet for a reason unrelated to the suspect box — is airtight for
silence; it says nothing about an affirmative answer, because a broken
local connection can suppress a reply but cannot manufacture one. So when
a direct path reads `"alive"`, the shared-cause question is already
answered regardless of what the control says: `evaluateWedge()` returns
`NOT_PROVEN` — never `INCONCLUSIVE_BY_SHARED_CAUSE`, which would then be a
false claim that nothing could be concluded. See "Direct paths" below for
the full rule and its scope.

### The independence trap

There is no local/LAN control path for Wyze plugs — every operation
`wyzr` can perform goes through Wyze's cloud (`docs/wyze-api-findings-2026-09-02.md`),
so the lever depends on the **manager machine's own internet** (see "Three
different machines" at the top of this README). Put that next to rule 1
above: if the manager machine's own internet is down, the Jira instrument
goes silent, the GitHub instrument goes silent, ssh dies, and tunnel ping
dies — all from the SAME cause, none of it evidence about the suspect box.
A naive two-silent-probes check would read that as a proven wedge. It is
the operator's own router.

So independence is **a real computation over each instrument's declared
dependency set** (`src/wedge.ts`'s `InstrumentObservation.dependsOn`),
never a hardcoded "we have two probes, therefore two instruments." Both
the Jira- and GitHub-activity instruments declare
`["manager-internet"]` as their dependency. Two silent instruments that
share a dependency are independent evidence ONLY when that shared
dependency has been separately confirmed healthy — which is exactly the
**local-connectivity control**'s job (see below). Sharing a dependency, on
its own, never satisfies rule 1 — `src/wedge.ts`'s
`computePairIndependence()` is the one place this is decided, and it is
unit-tested directly (`test/unit/wedge.test.ts`) with a case built so that
naively counting the pair would produce PROVEN and the correct engine must
not.

**The control is a precondition of PROVEN, not merely a tiebreaker for
instruments that happen to declare a shared dependency (WYZR-22).** In
this architecture "no declared dependency in common" is never actual proof
of "no shared cause": every instrument `wyzr` can observe is probed from
the manager machine, over that machine's one internet connection, whether
or not an instrument's own `dependsOn` happens to say so. So
`evaluateWedge()` checks `localControl.outcome === "healthy"` BEFORE it
ever looks at what any pair of silent instruments declared — whenever two
or more instruments are silent and the control was not successfully read
as healthy, the verdict is `INCONCLUSIVE_BY_SHARED_CAUSE` regardless of
whether their dependency sets overlap, **unless a direct path has already
read `"alive"` (WYZR-23) — that check runs even earlier, before this one
can return `INCONCLUSIVE_BY_SHARED_CAUSE`, and forces `NOT_PROVEN` instead;
see "The proof standard" and "Direct paths" for why.** Only once the
control is confirmed healthy (or the alive short-circuit has already
returned) does the declared-dependency computation above run, to decide
which pairs, if any, count as independent. (A single silent instrument
never reaches this check at all — see "The proof standard" above: one
silent probe is a network blip, not a shared-cause question.)

### The instruments

Each instrument is injectable (`src/wedge-probes.ts`'s `WedgeProbes`
interface — the same injectable-boundary pattern as `WyzeTransport`; see
`src/transport.ts`), has a **configurable quiet threshold** and a
**configurable timeout**, and has **no defensible default for what it
points at** — see "Configuration" below.

- **Jira-activity** (`src/wedge-probes-real.ts`'s `checkJiraActivity()`) —
  the most recent issue update visible to the configured credential
  (`GET /rest/api/3/search?jql=ORDER BY updated DESC`), and how long ago
  it was.
- **GitHub-activity** (`checkGitHubActivity()`) — the most recent public
  event on the configured org/repo
  (`GET /repos/<owner>/<repo>/events` or `/orgs/<owner>/events`), and how
  long ago it was.

Both declare `dependsOn: ["manager-internet"]` — see "The independence
trap" above.

**An unconfigured, throwing, or timed-out instrument NEVER silently drops
out of the count.** `src/wedge-runner.ts` always produces a row for both
instrument slots, configured or not — an unconfigured instrument reports
itself with `outcome: "unconfigured"` rather than simply being absent from
the evidence trail, and `src/wedge.ts`'s quorum computation only ever
counts an instrument whose `outcome === "observed"` AND whose quiet
duration has reached its threshold. A missing, erroring, or timed-out
instrument reduces confidence — it is recorded and named in `reasons` —
it never leaves one remaining probe looking like a quorum of two.
`test/unit/wedge.test.ts` has a dedicated test constructing exactly that
"dropping this would look like two" case and asserting refusal.

### Direct paths

ssh and tunnel ping (`src/wedge-probes.ts`'s `DirectPathConfig`,
`checkSsh()`/`checkTunnelPing()`). **"Dead" is a positive claim, never the
default reading of an error or a misconfiguration** —
`src/wedge-probes-real.ts`'s `classifyDirectPath()` establishes it two
ways, deliberately by TIMING rather than by parsing the underlying tool's
stderr text (locale- and version-dependent):

1. This probe's own overall timeout elapsed with no response at all.
2. The tool exited on its own, after roughly exhausting its OWN
   connect-timeout budget (within 10% of it) — its own timeout, not
   wyzr's, ran out with nothing back.

A FAST response of any kind — success, an explicit refusal, an
unresolvable hostname, a local misconfiguration — is `"unconfirmed"`,
never `"dead"`: a fast reply of any shape means something answered
quickly enough that "no response at all" was not what was observed, and
per this repo's refuse-by-default posture, ambiguous evidence must never
be read as the positive claim `"dead"` requires. **All configured direct
paths must be confirmed dead for PROVEN** — a single alive or unconfirmed
path blocks it, even with everything else satisfied.

**This timing-based classification was verified live** against this
project's own dev sandbox, 2026-09-10: an unresolvable hostname fails via
`ssh`/`ping` in well under 100ms; a real multi-second connect-timeout
budget is nowhere near exhausted by that. Reachability of a well-known
public host (`1.1.1.1`) was also confirmed live the same day (a normal,
fast ICMP reply). Neither observation involved any fleet-specific host.

**An affirmatively `"alive"` reading outranks the local-connectivity
control (WYZR-23).** The control precondition (rule 2 in "The proof
standard", and "The independence trap" above) exists to explain away
SILENCE: if the manager machine's own internet is down, every instrument
goes quiet for a reason that has nothing to do with the suspect box. That
argument says nothing about an affirmative answer — a broken local
connection can suppress a reply, but it cannot manufacture one. So if a
direct path reads `"alive"`, something on the far end answered: direct,
unconfounded, positive evidence about the suspect box, strictly better
than anything the control could have told us. `evaluateWedge()` checks for
an `"alive"` direct path BEFORE it can return `INCONCLUSIVE_BY_SHARED_CAUSE`
for a non-healthy control, and returns `NOT_PROVEN` instead — reporting
"I could not look" would be a false statement about our own epistemic
position once a direct path has already answered. Scoped narrowly: only
`"alive"` does this. `"dead"` and `"unconfirmed"` say nothing positive
about the box, so the control precondition still governs those cases
exactly as WYZR-22 left it, unchanged. And whichever verdict is actually
reached, `reasons` always names an `"alive"` direct path explicitly — not
only in this short-circuit — so the single most decision-relevant fact
available is never absent from the trail a human reads.

**Published for reuse (WYZR-18):** these two probes, and the
`RealWedgeProbes` class/`WedgeProbes` interface they implement, are meant
to answer "is it alive?" as well as "is it dead?" — `RawDirectPathOutcome`
already has a first-class `"alive"` value for exactly this reason. WYZR-18
(post-cycle recovery verification, filed and shelved on this work's merge)
reuses this same boundary rather than writing its own; see "Published
interface" below for the full statement of what is and is not part of
that contract.

### The local-connectivity control — the shared-cause exclusion

`src/wedge-probes.ts`'s `LocalConnectivityConfig`,
`checkLocalConnectivity()`. Its job is to rule out "the manager machine's
own internet is down" as the cause of two silent instruments — see "The
independence trap" above. It is **structurally NOT an instrument**:
`LocalConnectivityObservation` is a distinct, singular field on
`WedgeInput` (`src/wedge.ts`), never a member of the `instruments` array
the quorum/independence computation reads — there is no collection an
editor could push it into that would let it get counted, which is a
compile-time property, not a convention (see "Structural guarantees"
below).

**Default target:** `1.1.1.1` (Cloudflare's public anycast DNS resolver)
— chosen because it has no dependency on this project's own fleet
infrastructure, is a well-known, high-uptime public service, and is safe
to name in a public repo, unlike a fleet hostname would be. This is this
project's own choice (not a contract Cloudflare has made with this
project), and it is the ONE field in this whole command with a defensible
default — see "Configuration" below for why every other field has none.
Reachability of this default target was confirmed live from this
project's own dev sandbox, 2026-09-10 (a single ICMP echo, ~20ms round
trip).

When the control reports `"healthy"`, it also names WHICH dependency ids
it confirms (`confirms: ["manager-internet"]`) — that is what
`computePairIndependence()` checks a shared dependency against, not just
"the control ran."

### Control-plane: recorded, structurally powerless

`src/wedge-probes.ts`'s `ControlPlaneConfig`, `checkControlPlane()` —
tailscale-style liveness (`tailscale status --json`'s `Self.Online`
boolean field). **Recorded in the evidence trail; NEVER read when
deciding a verdict, in either direction.**

This is not a hypothetical caution. During the real 2026-09-02 wedge, the
tailscale coordination server reported `Online=True` the entire time — a
control plane happily reporting on a box whose data plane was dead. A
second, independently measured instance of the identical shape came out
of the 2026-09-10 hand-run confirming the fleet plug: reading the plug's
own `P5` (reachability) and `conn_state` properties said NOTHING about
whether the box behind the plug had actually come back. wyzr does not
probe the plug (out of this task's scope), but the exclusion this type
enforces is generic to ANY liveness-only signal, not specific to
tailscale — see `src/wedge.ts`'s `ControlPlaneReading` doc comment for the
full statement of why a hypothetical future plug- or cloud-liveness
reading would be excluded the same way, for free, simply by being given
this type rather than `InstrumentObservation`'s.

**Made structural, not conventional, two ways:**

1. `ControlPlaneReading` carries none of `InstrumentObservation`'s fields
   and a distinct `__brand` literal tag — TypeScript's structural typing
   already makes it inadmissible to `WedgeInput.instruments`, and the
   brand keeps that true even in a hypothetical future where the rest of
   the shape happened to converge. `test/unit/wedge.test.ts` proves this
   is real, not decorative: it contains a line that only compiles WITH a
   `@ts-expect-error` directive, and `bun run typecheck` fails if that
   directive is removed — verified by actually removing it and observing
   the exact `TS2739` error before restoring it.
2. `src/wedge.ts`'s `evaluateWedge()` never branches on `input.controlPlane`
   before a verdict is already decided — the reading is only copied into
   `reasons` AFTER the verdict, so it is provably incapable of changing
   what was already chosen. `test/unit/wedge.test.ts` proves this in both
   directions: an `online: true` reading cannot flip a would-be-refused
   verdict to PROVEN, and cannot flip an already-PROVEN verdict to
   refused either.

Confirmed live against this project's own dev sandbox, 2026-09-10: a real
`tailscale status --json` invocation returns a top-level object whose
`Self.Online` field is a genuine JSON boolean — no host, IP, or other
sandbox-identifying value from that output is reproduced anywhere in this
repo or this section, per the absolute rule below.

### The degradation window, and which way the gate errs

On 2026-09-10 the real OOM began at 06:11 and the box's process-supervisor
sockets were lost at 07:09 — roughly an hour where the box was degrading
but not yet gone. **This engine deliberately targets the "definitively
gone" window, not that degrading hour** — cutting power kills every
in-flight agent turn with no drain and no undo, and memory pressure is a
condition the kernel's own OOM killer exists to resolve, so firing early
would have destroyed turns that were still making progress with recovery
still a live possibility.

**The corollary is this command's actual requirement.** Because the
automated gate deliberately fires late, the degrading hour is where a
HUMAN's judgment has to act — and a human has now TWICE correctly
identified a wedge before any tooling did. `wyzr wedge status` must be
genuinely useful DURING that hour: it reports how long each instrument
has been quiet, when each was last heard from, what the direct paths did,
and which verdict follows and why — **the evidence is the product; the
verdict is a summary of it, never a bare yes/no.**

**The gate errs TIGHT, toward refusing.** A verdict of PROVEN requires
EVERY condition above to be affirmatively established — absence of
evidence is never read as evidence. Concretely: an unconfigured,
erroring, or timed-out instrument or direct path is never treated as
silent/dead by default; it is excluded from the quorum and named in
`reasons` instead. A gate too loose power-cycles a healthy box carrying a
dozen agents — unrecoverable and self-inflicted. A gate too tight
degrades to the status quo: a human walks to the room, which has already
happened twice and is bad but survivable. A human with physical knowledge
of the box outranks any heuristic this engine can write; this engine's
job is to make the evidence legible, not to be the party that decides.

### Structurally read-only

`src/cli-wedge.ts` imports nothing from `src/cli-plug.ts`, `src/plug.ts`,
`src/auth-session.ts`, or any transport module — there is no import path
from this command to a write verb, checkable by reading its own imports,
not by a runtime flag someone could flip. Nothing this command's own
module graph can reach ever calls `WyzeTransport.setProperty()` or
anything that could switch a plug.

### The engine's public surface (WYZR-16: "what later stories inherit
from your shape")

Two later, already-filed stories are shelved on this task's merge and
build directly on the shape chosen here, so this section states plainly
what is a published interface and what is free to change:

**Published — WYZR-19 (`wyzr cycle`) calls this and is forbidden from
widening it:**
- `src/wedge.ts`: `WedgeVerdict` (a plain value to switch on — `"PROVEN"`
  / `"NOT_PROVEN"` / `"INCONCLUSIVE_BY_SHARED_CAUSE"` — never something a
  caller has to reconstruct from formatted text), `evaluateWedge()`, and
  every exported type in that file (`WedgeInput`/`WedgeResult` and the
  observation/assessment shapes).
- `src/wedge-runner.ts`: `runWedgeCheck()` / `RunWedgeCheckOptions` — how
  a non-CLI caller runs the full check and gets a `WedgeResult` back.
  Needs nothing from `src/cli-wedge.ts`.

**Published — WYZR-18 (post-cycle recovery verification) reuses this
boundary and these probes rather than writing its own:**
- `src/wedge-probes.ts`: the `WedgeProbes` interface and every config
  type, in particular `RawDirectPathOutcome`'s first-class `"alive"`
  value.
- `src/wedge-probes-real.ts`: the `RealWedgeProbes` class — specifically
  `checkSsh()`/`checkTunnelPing()`, reusable to ask "is it alive?" through
  the same methods this task uses to ask "is it dead?" — and the exported
  `classifyDirectPath()` pure classifier.

**Internal, free to change:** `src/cli-wedge.ts` (formatting/JSON
projection), `src/config.ts`'s loader internals (its own helper functions —
see "Configuration" below for the loader's own documented contract, which
is NOT free to change casually), and every unexported helper in
`src/wedge-runner.ts` (`attempt()`, the `toXObservation()` functions).

### Configuration

**No fleet hostname, tunnel name, or credential is hardcoded anywhere in
this repo.** This repo is public; epic WYZR-1 deliberately kept fleet
hostnames out of it, which this task keeps doing. Every host-specific
value is injectable, through the ONE configuration surface described here
and shared by `wyzr wedge status`, `wyzr recovery status`, and `wyzr
cycle` alike — see `wyzr cycle`'s own "Configuration" section below for
the full schema; this subsection covers only the fields THIS command
reads.

**WYZR-20/WYZR-28: the CLI now reads a real, file-backed config —
`src/config.ts`'s `loadWyzrConfig()` — never an environment variable.**
The file lives at `<XDG_CONFIG_HOME or $HOME/.config>/wyzr/config.json`,
resolved by the exact same rule `src/credentials.ts` already uses for
`credentials.json`. A missing file, an over-permissive directory or file
(`mode & 0o077`), unparseable JSON, a missing required value, or a
present-but-incomplete optional section are all REFUSALS — never a
silent default, never a partial load. `docs/config.example.json` is a
complete, placeholder-only, genuinely-loadable example of every required
and optional key (a test asserts it actually loads).

This command reads:

| Config key | Configures |
| --- | --- |
| `suspectBox.host` (**required**) | The ssh direct path's target. The SAME value also feeds `wyzr cycle`'s wrong-box guard and `wyzr recovery status`'s reused-host probes — see `wyzr cycle`'s own "Configuration" section for why this is deliberately ONE field, never two that could disagree. `suspectBox.timeoutMs`/`.connectTimeoutMs` default to `5000`/`3000`. |
| `jira` (optional section: `baseUrl` + `authHeader` required together if present) | Jira-activity. `projectKey` narrows the query; `quietThresholdMs`/`timeoutMs` default to `600000`/`5000`. |
| `github` (optional section: `owner` required if present) | GitHub-activity. `repo` scopes to one repo (org-wide otherwise); `token` is optional (unauthenticated works for public targets, at a lower rate limit — see below); `quietThresholdMs`/`timeoutMs` default to `600000`/`5000`. |
| `tunnelPing` (optional section: `host` required if present) | The tunnel-ping direct path. `timeoutMs`/`connectTimeoutMs` default to `5000`/`3000`. |
| `localConnectivity` (optional — every field defaults) | Overrides the local-connectivity control's default target (`1.1.1.1`) and/or timeout (`5000`) — the one instrument that already has a safe default, so the whole section may be omitted. |
| `controlPlane` (optional section: `name` required if present) | Opts the control-plane reading in; `timeoutMs` defaults to `5000`. |

Every section marked "optional" above may be omitted entirely — that
instrument then reports itself **UNCONFIGURED**, exactly as it did under
the old provisional env-var loader ("an unconfigured instrument must
count toward a quorum" — see "The instruments" above — must and does
survive this rewrite). **But a section that IS present must be
COMPLETE:** e.g. a present `jira` section missing `authHeader` is a
REFUSAL naming `jira.authHeader`, never a partial load that leaves
Jira-activity quietly half-configured. `suspectBox.host` has no such
escape — it is required in every config that loads at all.

### The `--json` contract

`WEDGE_SCHEMA_VERSION` (`src/cli-wedge.ts`), starting at `1`, following
this repo's established per-command schema-version precedent
(`DEVICE_LIST_SCHEMA_VERSION`, `PLUG_SCHEMA_VERSION`) — additive-only.

```json
{
  "schemaVersion": 1,
  "command": "wedge status",
  "verdict": "NOT_PROVEN",
  "reasons": ["..."],
  "instruments": [
    {
      "name": "jira-activity",
      "dependsOn": ["manager-internet"],
      "outcome": "unconfigured",
      "lastSeenAt": null,
      "quietForMs": null,
      "quietThresholdMs": 600000,
      "silent": false,
      "note": "not configured — no operator-supplied target for this instrument"
    }
  ],
  "directPaths": [
    { "name": "ssh", "outcome": "unconfirmed", "note": "not configured — no operator-supplied host for this direct path" }
  ],
  "localControl": { "name": "local-connectivity", "outcome": "healthy", "confirms": ["manager-internet"], "note": null },
  "controlPlane": []
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `verdict` | `"PROVEN"` \| `"NOT_PROVEN"` \| `"INCONCLUSIVE_BY_SHARED_CAUSE"` | See "The proof standard" above. |
| `instruments[].outcome` | `"observed"` \| `"error"` \| `"timeout"` \| `"unconfigured"` | Only `"observed"` can ever be `silent: true`. |
| `instruments[].lastSeenAt` | `string` (ISO 8601) or `null` | `null` unless `outcome === "observed"`. |
| `directPaths[].outcome` | `"dead"` \| `"alive"` \| `"unconfirmed"` | See "Direct paths" above — "dead" is a positive claim, never a default. |
| `localControl.confirms` | `string[]` | Dependency ids this reading, if `outcome === "healthy"`, rules out as a shared cause. |
| `controlPlane[].online` | `boolean` \| `"unknown"` | Recorded only — never consulted for the verdict. |
| `note` (instruments/directPaths/localControl/controlPlane) | `string` or `null` | Fragment-safe — never any part of a raw response value or a credential, same rule as `devices list`'s `note`. |

This is allowlist-projected by `src/cli-wedge.ts` from this module's
internal `WedgeResult` shapes — never a raw spread of them, which carry an
internal `__brand` discriminant that has no business in a published API
(same "name every field" rule as `devices list`/`plug status`'s own
contracts).

### Real output, captured live (not a synthetic example)

Run against this project's own dev sandbox, 2026-09-10, with the
GitHub-activity instrument and the control-plane reading genuinely
configured (a public repo lookup and a local `tailscale status --json`
call — neither needs a credential), everything else left at its honest
default of unconfigured:

```
Verdict: NOT_PROVEN

Instruments:
  - jira-activity: UNCONFIGURED (excluded from quorum) — manager-internet — not configured — no operator-supplied target for this instrument
  - github-activity: SILENT, last seen 2026-09-03T04:46:22.000Z, quiet for 182h18m54s (threshold 1m0s) — depends on: manager-internet

Direct paths:
  - ssh: UNCONFIRMED — not configured — no operator-supplied host for this direct path
  - tunnel-ping: UNCONFIRMED — not configured — no operator-supplied host for this direct path

Local-connectivity control (local-connectivity): HEALTHY — confirms: manager-internet

Control-plane (informational only — cannot affect the verdict):
  - tailscale: true

Reasons:
  - instrument "jira-activity" could not be read (unconfigured) — excluded from the quorum, never treated as silent or active
  - only 1 instrument(s) observed silent — at least 2 independently-silent instruments are required, never fewer
```

Exit code: `11` (`wedge_not_proven`). The `--json` form of this exact run
is in the PR description for this change.

**The vantage-point caveat this capture is honest about, on purpose:**
this command was run from this project's own dev/agent sandbox, which —
per this README's own "Three different machines" section at the top — is
almost certainly NOT the manager machine the design assumes, and may be
on or adjacent to the very box this system exists to protect. A
direct-path probe aimed at the suspect box and run FROM the suspect box
would measure nothing, and a local-connectivity control run there is not
the control this design means. **That is exactly why ssh, tunnel ping,
and Jira are left unconfigured in this capture** rather than pointed at
anything: this repo names no fleet host, so there was nothing honest to
point them at from here. The GitHub-activity and control-plane readings
above ARE genuine, meaningful captures regardless of vantage point (a
public API and a local daemon query, neither fleet-host-dependent) — they
are not staged. No hostname, IP, or other sandbox-identifying value from
this environment appears in this capture or anywhere else in this repo.

### Tests

Each refusal case the ticket requires has its own named test in
`test/unit/wedge.test.ts`: a fully healthy box refused; one silent
instrument with the other live refused; both silent with the
local-connectivity control failing reported INCONCLUSIVE (never PROVEN,
never treated as healthy); both silent with the control healthy but a
direct path still alive refused; a green control-plane reading unable to
flip a PROVEN verdict to refused (and unable to manufacture one on its
own); a control-plane reading unable to be counted as an instrument
(the `@ts-expect-error` proof); a degraded instrument that must not
silently vanish from the quorum; and two instruments sharing a
dependency failing rule 1 on their own. `test/unit/wedge.test.ts` also
pins behaviour exactly AT a quiet threshold and on each side of it — only
expressible because `now` is an injected value, never an ambient clock
read (see below).

`src/wedge.ts` calls no ambient time source anywhere — no `Date.now()`,
no `setTimeout`, no wall-clock read of any kind. `WedgeInput.now` is the
only time this module ever sees, injected by its caller. This repo is
deliberately retry-free and timer-free with a deterministic suite; that
property extends here rather than being reintroduced by this task. Real
per-probe timeouts (a genuinely different concern) live in
`src/wedge-runner.ts`'s I/O layer, never in the engine.

`test/unit/wedge-probes-real.test.ts` and
`test/unit/wedge-probes-fake.test.ts` exercise the real and fake probe
implementations directly, with zero network beyond harmless local
subprocess spawns (`true`/`sleep`/`echo`) used to exercise the real
timeout/classification machinery honestly rather than only ever behind a
fake. `test/unit/wedge-runner.test.ts` and `test/unit/cli-wedge.test.ts`
exercise the orchestration and CLI-wiring layers against `FakeWedgeProbes`.

### What has never been run against reality

**Jira-activity has never been exercised against a real Jira instance.**
`checkJiraActivity()`'s request/response shape
(`/rest/api/3/search?jql=...`, reading `issues[0].fields.updated`) is tier
(b) — read from Atlassian's own public REST API documentation — never
captured live in this project, because doing so would require a real
credentialed call against a real Jira instance, which this task has no
occasion or authorization to make. Everything else below WAS captured
live from this project's own dev sandbox, 2026-09-10, and is not merely
assumed:

- **GitHub's events API shape** — `checkGitHubActivity()`'s reliance on a
  top-level `created_at` field per array entry — was captured from a
  real, unauthenticated `GET /repos/brooswit-factory/wyzr/events` call
  (see `src/wedge-probes-real.ts`'s top comment and
  `test/unit/wedge-probes-real.test.ts`'s `CAPTURED_EVENT` fixture for
  the trimmed real response). Unauthenticated requests are rate-limited
  to 60/hour (confirmed from that same response's own headers).
- **ssh/ping timing behavior** — an unresolvable hostname fails in well
  under 100ms; a real host replies in tens of milliseconds — informing
  `classifyDirectPath()`'s design (see "Direct paths" above).
- **`tailscale status --json`'s `Self.Online` field** — confirmed to be a
  genuine JSON boolean at that exact path, from a real invocation against
  this project's own dev sandbox's tailscale daemon.

**Never exercised against a real ssh target, a real tunnel-ping target,
or a real fleet box of any kind** — this repo names no such host, so
`classifyDirectPath()`'s "dead" classification has only ever been
exercised against harmless local commands (`true`/`false`/`sleep`) in
this repo's own test suite, never against an actually-wedged remote
machine. Whether a genuinely frozen box's ssh/ping behavior matches the
timing model this classifier assumes is, like the rest of this repo's
device-facing code, unverified against reality until it is.

## `wyzr recovery status`

The post-cycle recovery engine (WYZR-18/WYZR-25) and its read-only CLI
surface — the thing that answers "did that power cycle actually work?" with
evidence, not assumption, after the destructive `wyzr cycle` verb (a later
story) runs. **This command cannot switch a plug, and is not capable of it —
see "Structurally read-only, and no import path to the plug at all" below.**

```sh
wyzr recovery status --since 2026-09-11T10:20:00Z           # human-readable
wyzr recovery status --since 2026-09-11T10:20:00Z --json    # machine-readable, stable shape
```

`--since` (an ISO 8601 timestamp) is **required, with no default** — it is
the moment power was cut, supplied by the caller because only the caller
knows it. Missing, unparseable, or future-dated is a Usage error (`2`),
never a guess: defaulting to "now minus something" would silently change
the verdict. This is also designed so a human can run it standalone after
any unrelated reboot, not only after `wyzr cycle`.

### Why this exists, and the one failure mode it exists to avoid

`wyzr wedge status` (WYZR-16/WYZR-17) was formally reviewed three times and
bounced twice, and **both defects were the same thing: the product asserted
something untrue about its own knowledge** — a trail claiming a check that
never ran, and a verdict claiming an inability the code did not actually
have. This command's entire output is a claim about the same kind of thing:
"the box rebooted," "the daemons are healthy," "the fleet came back." Every
one of those can be false in exactly that way, so every check below is built
to say **"could not look"** rather than guess, and every line of prose this
command emits is meant to be true about what was **observed**, never merely
about what was **attempted**.

### The five checks

Each behind the injectable probe boundary (`src/wedge-probes.ts`'s
`WedgeProbes`, reused verbatim for four of these — see below — plus this
story's own `src/recovery-probes.ts`'s `RecoveryProbes` for the three
genuinely new ones), each reporting **independently rather than collapsing
early**, each able to say "could not look." Every check reports one of four
states — `PASS` / `FAIL` / `COULD-NOT-LOOK` / `NOT-CONFIGURED` — the same
four-way vocabulary the top-level verdict itself uses (see "The verdicts and
their precedence" below), so the same epistemic distinction the ticket
demands of the daemon check applies uniformly everywhere.

**1. Reachability** (`src/wedge-probes.ts`'s `checkSsh`/`checkTunnelPing`,
reused verbatim from WYZR-16 — no second pair of probes). **What output
would mean FAILURE:** every configured direct path reads `"dead"` or
`"unconfirmed"` (silence) **while the local-connectivity control is healthy**
— an affirmatively confounded-free "nothing answered." An `"alive"` reading
on ANY configured path is `PASS` on its own: it is direct, unconfounded
evidence (a broken local connection can suppress a reply, but cannot
manufacture one). Silence while the local-connectivity control is
**unhealthy, errored, timed out, or unconfigured** is `COULD-NOT-LOOK`, never
`FAIL` — see "The local-connectivity gate on silence" below for why.

**2. Reboot** (`src/recovery-probes.ts`'s `checkUptime`, new). **What output
would mean FAILURE:** the box's own uptime (a DURATION, read from its own
monotonic counter — see "Why the reboot baseline is the power-off instant"
below) is **not less than** the elapsed time since `--since`. That means the
box has been up since before the cut and never rebooted — this is exactly
what catches the cycle verb silently no-opping (a plug that flickered
without the box actually restarting). A reading that could not be obtained
or parsed is `COULD-NOT-LOOK`, **never** a pass or a fail, and never falls
back to a wall-clock method.

**3. Daemon** (`src/recovery-probes.ts`'s `checkDaemon`, new — `systemctl
[--user] show <unit> --property=LoadState,ActiveState`). Configured unit AND
scope, **no default for either**. Four distinguishable raw outcomes:
**healthy** (found, running), **unhealthy** (found, not running),
**pointed-at-nothing** (`LoadState=not-found` — what a WRONG SCOPE looks
like; this repo's own sharp edge is that a system-level `journalctl -u
<unit>` against a user unit prints "-- No entries --", not an error, which
is why this check uses `systemctl show` and reads its OUTPUT CONTENT rather
than `journalctl` at all), or a genuine probe failure. **What output would
mean FAILURE:** `ActiveState` is anything other than `active` on a unit that
IS loaded (`unhealthy`) — this rolls up to the check-level `FAIL`.
`pointed-at-nothing` rolls up to `COULD-NOT-LOOK` (we looked in the wrong
place, never "found it unhealthy") — see "The daemon check's four raw
outcomes, and why pointed-at-nothing is not a fail" below.

**4. Outside instruments resumed** (`src/wedge-probes.ts`'s
`checkJiraActivity`/`checkGitHubActivity`, reused verbatim — no second
pair). **What output would mean FAILURE:** every configured instrument's
last observed activity is at or before `--since` — silence since before the
cut proves nothing about recovery, and this stays true even when ssh has
already returned (the only signal showing the box doing useful WORK, not
merely being up). At least one configured instrument's activity being AFTER
`--since` is enough to `PASS`.

**5. The fleet actually came back — the herdr-restore trap**
(`src/recovery-probes.ts`'s `checkFleetAudit`, new). **What output would
mean FAILURE:** either zero candidate agent processes are found at all
("the fleet did not come back" — a different finding from "could not
look"), or one or more found candidates are missing the configured expected
spawn flags ("bare" — a pane restored as a bare `claude --resume <id>`,
looking alive while unable to do anything). The latter shape, when the box
itself is otherwise confirmed back, is what promotes the top-level verdict
to its own class, `FLEET_HALF_RESTORED` — see below. Reports **COUNTS
ONLY**: no session id, token, pid, or raw command line reaches any output
field on any path, including every error path — see "The fleet-audit
redaction boundary" below.

### Why the reboot baseline is the power-off instant, and why a duration comparison rather than an instant one

The obvious design — read boot time before the cycle, read it after, assert
it moved — is **unimplementable**: a wedged box cannot be read BEFORE the
cut, because being unreadable is what wedged means. The baseline that always
exists is **the timestamp of the power-off itself**, supplied by the caller
as `--since` (required, no default — a guess here would silently change the
verdict).

The required property: after the box returns, its boot must be LATER than
the moment power was cut — and a box whose clock is behind or ahead must
produce **neither a false PASS nor a false FAIL**. `who -b`/wall-clock boot
time is the naive approach, but it reports a WALL-CLOCK instant, and a
freshly-booted box may not have resynced its clock — comparing that against
the manager's own `--since` is a comparison between two machines' wall
clocks after an unclean power loss, not something to build a safety check
on.

**The skew-safe formulation compares the box's own UPTIME (a duration on its
own monotonic counter, which no wall-clock skew or NTP step moves) against
the ELAPSED time since the cut (a duration measured entirely on the
manager's own clock).** Two durations, each from ONE clock, never a
cross-machine INSTANT comparison. `uptime < elapsed` means it booted after
the cut; `uptime >= elapsed` means it has been up since before the cut, so
it never rebooted and the check FAILS.

**How the uptime duration is obtained:** `cat /proc/uptime` over ssh — its
first field is seconds since boot, read from the kernel's own monotonic
clock, never the wall clock. This is Linux-specific, stated here rather than
promised as portable. A reading this probe cannot parse is `COULD-NOT-LOOK`
— never a pass, never a fail, and NEVER falls back to a wall-clock method,
which would reintroduce the exact skew hazard this design removes.

**`elapsedMs` is measured conservatively:** `src/recovery-runner.ts`
captures the manager's clock BEFORE any probe starts (`now - since`,
computed from the SAME `now` every probe races against), not from after a
reply arrives. A later instant would inflate `elapsedMs`, biasing toward
`uptime < elapsed`, i.e. toward a false PASS — the reasoning is in that
module's own comment, not just this rule.

### Why plug-liveness is not read at all — not "recorded and powerless," genuinely absent

**This is a deliberate departure from `wyzr wedge status`'s own design.**
WYZR-16's engine RECORDS a control-plane (tailscale-style) liveness reading
in its evidence trail, structurally incapable of affecting the verdict.
**This command goes one step further: it reads no plug-liveness signal at
all — no `P5`, no `conn_state`, nothing the cloud says about the plug.** Two
reasons, both settled by the epic:

1. **A structurally powerless signal is not worth the cost of fetching.**
   The 2026-09-10 hand-run that confirmed the fleet plug measured this
   directly: the plug's own `P5` (reachability) and `conn_state` properties
   read live/reachable while saying NOTHING about whether the box behind the
   plug had actually come back — ssh returning and `who -b` showing a new
   boot time is what confirmed recovery. `P5`/`conn_state` are this
   product's own `Online=True` — a cloud control plane asserting liveness
   about a thing it cannot see inside.
2. **Reading it would require importing this repo's Wyze transport and plug
   modules** — precisely the import path "Structurally read-only" below
   forbids.

**The type-level exclusion still exists and is tested anyway**, because
WYZR-19 (`wyzr cycle`) WILL hold a plug reading when it calls this engine and
is the realistic party who would pass one in.
`src/recovery.ts`'s `PlugLivenessReading` mirrors `src/wedge.ts`'s
`ControlPlaneReading` exactly: a distinct `__brand` nominal tag and no
overlapping fields with any evidence-collection type, so a liveness-only
reading is not assignable into `RecoveryInput.reachability` or
`RecoveryInput.instruments`, pinned with `@ts-expect-error` the same way
WYZR-16's own tests pin `ControlPlaneReading`.
**Verified by actually removing the two directives and observing the
compiler error** (`tsc` reported `TS2739: Type 'PlugLivenessReading' is
missing the following properties from type 'RecoveryDirectPathObservation':
name, outcome` and the equivalent for `RecoveryInstrumentObservation`),
then restoring them — see the PR description for the full transcript.
Separately, `test/unit/recovery.test.ts` constructs the case where the box
is affirmatively gone (silence on every configured check, with the
local-connectivity control healthy so the silence is unconfounded) and
asserts `NOT_RECOVERED` — demonstrating that no hypothetical "perfect" plug
reading could have changed that outcome, because no such reading can ever
reach `evaluateRecovery()` in the first place.

### The herdr-restore trap, and why wyzr reports rather than fixes it

Live and current, not historical: an agent on this very product was
restarted for exactly this reason on 2026-09-10. **The restoring component
brings panes back as a bare `claude --resume <id>`, WITHOUT the daemon's own
spawn flags.** A restored agent looks alive while missing the flags that
make it able to do anything — a pane with a session in it, not a working
agent. A pane/process COUNT alone is not evidence of recovery.

**The epic has decided, and this story implements it: wyzr DETECTS AND
REPORTS this and does NOT fix it.** Fixing it would mean a SECOND spawner
racing the daemon's own reconcile poll; the defect belongs to the component
that does the restoring, and papering over it removes the pressure to fix it
at the source; and wyzr runs on the manager box, so fixing it would mean
reaching into the rescued box's userspace — the exact coupling this product
exists to avoid. **The repair is filed outside this epic, as WYZR-21.** This
command is a smoke detector, not a repair.

**The enumeration trap this check's design exists to avoid**, relayed on the
ticket from a real run against a live multi-agent box, 2026-09-10: a
bare-restored pane's argv carries NONE of the expected spawn flags at all
(the workspace path — where the ticket key would appear — lives INSIDE one
of the missing flags). So the obvious implementation — enumerate panes by
matching something only a HEALTHY pane has, then check flags within that set
— has a denominator that structurally excludes exactly the panes it exists
to catch, and would report "N of N healthy" forever on a fleet that is half
bare. **`src/recovery-probes.ts`'s `FleetAuditConfig`/`classifyFleetProcesses()`
build the candidate set from `processMatch` — something every candidate,
bare or not, still has (the binary name) — and apply `expectedFlags` only
AFTER that set exists, never as part of building it.** The denominator
(`totalCandidates`) is always reported alongside `bareCount` — "0 bare
panes found" is only meaningful next to a denominator that could have
contained one.

### The fleet-audit redaction boundary

**The redaction registry matches whole registered strings and cannot protect
against a value that was never registered — a session id is exactly such a
value.** So `src/recovery-probes-real.ts`'s `checkFleetAudit()` reads the
raw process-list text ONLY inside that one method, hands it ONLY to the pure
`classifyFleetProcesses()` classifier, and that classifier returns COUNTS
ONLY — `src/recovery-probes.ts`'s `RawFleetAuditReading` has no field a raw
argv string, pid, or session id could ever occupy, on ANY path, including
every error path (a nonzero ssh exit or a timeout never touches the raw
stdout at all). `test/unit/recovery-probes-real.test.ts` feeds the
classifier a fixture whose raw text contains a session-id-shaped string and
asserts that string appears nowhere in the returned object, at both the
pure-classifier level and the probe level (including the error path).

### The daemon check's four raw outcomes, and why pointed-at-nothing is not a fail

`healthy` / `unhealthy` / `pointed-at-nothing` / a genuine probe failure —
four states, not three, because "the unit does not exist under this scope"
(what a WRONG SCOPE looks like) must never read as "found and not running."
For the top-level verdict, `pointed-at-nothing` rolls up to `COULD-NOT-LOOK`
rather than `FAIL`: we looked, in the wrong place, so we genuinely do not
know whether the daemon is healthy — a claim of "unhealthy" here would be
exactly the kind of false claim about our own knowledge this whole command
exists to avoid.

### The local-connectivity gate on silence

**A broken local connection can SUPPRESS a reply, but it cannot MANUFACTURE
one** (the same asymmetry `wyzr wedge status` settled, applied here in the
opposite direction). ssh RETURNING is this command's strong signal — decisive
on its own, no control needed. But **"the box did not come back" resting
ONLY on silence is confounded the same way, in the other direction**:
reporting "it never came back" when it is the MANAGER's own internet that
died is the same false claim wearing the opposite hat. So the reachability
check's `FAIL` (every configured direct path silent) is gated on the
local-connectivity control (`src/wedge-probes.ts`'s `checkLocalConnectivity`,
reused verbatim) having been read and reporting healthy; if the control is
unhealthy, errored, timed out, or unconfigured, that silence is
`COULD-NOT-LOOK` instead. **An affirmative failure elsewhere is never
downgraded by this gate** — the reboot check's "never rebooted" reading, for
instance, can only be reached at all once ssh has already answered, so it is
unconfounded by construction and stays `FAIL` (and the overall verdict stays
`NOT_RECOVERED`) whatever the local-connectivity control did.

### The verdicts and their precedence

Five verdict classes, a distinct exit code per class (see the exit-code
table above), so a later `wyzr cycle` can tell them apart without parsing
prose:

- **RECOVERED** (exit `0`) — every configured check affirmatively PASSED,
  and nothing was unconfigured or unreadable.
- **NOT_RECOVERED** (exit `13`) — the box affirmatively did not come back,
  affirmatively did not reboot, or some other check affirmatively failed.
- **FLEET_HALF_RESTORED** (exit `14`) — the box itself is affirmatively back
  and rebooted (reachability AND reboot both `PASS`), but the fleet came
  back with bare agent processes present, and no OTHER check (daemon,
  instruments) also affirmatively failed. Its own verdict and its own code —
  distinguishable from both RECOVERED and "the box didn't come back at
  all," because its remedy differs from either.
- **INCONCLUSIVE** (exit `15`) — something load-bearing was LOOKED AT and
  could not be read, and nothing affirmatively failed.
- **UNCONFIGURED** (exit `16`) — nothing failed and nothing was unreadable;
  the only gaps are checks nobody was ever told where to point.

**Why the last two are separate — a ruling from the epic, carried over from
`wyzr wedge status`'s own second bounce, and not this task's to soften.**
"You never told me where to look" is an operator-fixable setup gap; "I
looked and could not see" is possible evidence about the box. Different
epistemic states. **What makes it urgent rather than tidy: UNCONFIGURED is
the NORMAL state for any optional section (daemon, fleet-audit, Jira,
GitHub, ...) an operator has simply chosen not to fill in.** Collapsing
the two means EVERY run with an optional section left out returns the
same verdict as a genuine "could not read it" — and a verdict that never
varies teaches an operator to stop reading it, so the one meaning "the box
is gone" would arrive looking identical to the two hundred meaning "you
left a section out of `config.json`."

**Precedence, in this exact order, each with the reasoning that justifies
it** (`src/recovery.ts`'s `evaluateRecovery()` own comment states the same
thing next to the code):

1. **FLEET_HALF_RESTORED** — ONLY when the box itself is confirmed back
   (reachability AND reboot both `PASS` — never report half-restored about a
   box with no evidence it returned) AND the fleet check's failure is
   specifically the bare-panes shape AND no OTHER check (daemon,
   instruments) also affirmatively failed — **a failure of the box itself
   outranks the fleet's shape.**
2. **NOT_RECOVERED** whenever any check affirmatively failed and rule 1 did
   not already apply — **an affirmative failure outranks an absence**; "I
   could not look at X" is never a reason to withhold a verdict already
   affirmatively established.
3. **INCONCLUSIVE** when nothing failed but at least one check could not be
   read — **a could-not-look outranks an unconfigured gap.**
4. **UNCONFIGURED** when nothing failed and nothing was unreadable.
5. **RECOVERED** only when every check affirmatively passed.

Neither `COULD-NOT-LOOK` nor `NOT-CONFIGURED` is EVER upgraded to a pass or
downgraded to a fail — only an actual per-check `FAIL` can reach rule 2, and
only `PASS` across every check reaches rule 5. **No check's pass is ever
inferred from another's** — an unreachable box is never "rebooted
successfully" on the strength of another check passing, because every check
above reads only its OWN raw observation.

### Structurally read-only, and no import path to the plug at all

`src/cli-recovery.ts` imports nothing from `src/cli-plug.ts`, `src/plug.ts`,
`src/auth-session.ts`, or any transport module — same property `wyzr wedge
status` already has, stated the same way (checkable by reading its own
imports, not a runtime flag someone could flip). **This story ships the real
test the ticket demands, which the wedge trio's own README section only
ever asserted in prose:** `test/unit/recovery-imports.test.ts` walks
`src/cli-recovery.ts`'s TRANSITIVE import closure and asserts none of
`plug.ts`/`cli-plug.ts`/`auth-session.ts`/`transport.ts`/`transport-http.ts`/
`transport-fake.ts` is reachable from it at all, plus a sanity floor
asserting the walk actually reached a meaningful number of this command's
own real dependencies first (so an empty/broken walk cannot pass this test
for the wrong reason — the same "assert the expected sample size before a
negative result means anything" rule this ticket applies elsewhere,
applied here to a structural check instead of a statistical sample).

**Watched RED first, per the ticket's explicit instruction:** a temporary
`import "./plug.ts";` was added to the top of `src/cli-recovery.ts`, this
test was run and OBSERVED TO FAIL — `error: .../src/plug.ts IS reachable
from src/cli-recovery.ts, via: .../src/cli-recovery.ts ->
.../src/plug.ts` — then the import was removed and the test re-run and
observed to pass. See the PR description for the full transcript.

### The probe composition: `WedgeProbes` reused verbatim, never widened

**`src/wedge-probes.ts`'s `WedgeProbes` is a published interface WYZR-19
depends on, and this story does NOT widen it** — adding methods would force
every existing implementation and fake to change for a consumer that is not
WYZR-19. `src/recovery-runner.ts`'s `runRecoveryCheck()` takes BOTH a
`WedgeProbes` (reused verbatim for `checkSsh`, `checkTunnelPing`,
`checkJiraActivity`, `checkGitHubActivity`, and `checkLocalConnectivity` —
**not** `checkControlPlane`, which this story has no use for) AND a new,
separate `RecoveryProbes` (`src/recovery-probes.ts` — the three genuinely
new probes: uptime, daemon, fleet-audit). Composition over widening.

### Config reuse, and the one host field this story does NOT introduce

**WYZR-20/WYZR-28: this command now reads the same file-backed
`src/config.ts`'s `loadWyzrConfig()` every other command reads — see `wyzr
wedge status`'s own "Configuration" section above for the loader's shared
discipline (missing/unparseable/incomplete-section refusals, permission
checks, `docs/config.example.json`).** It does not re-declare config keys
for anything `wyzr wedge status` already owns: the SAME `jira`, `github`,
`tunnelPing`, and `localConnectivity` sections, and the SAME
`suspectBox.host`, configure both commands, because both probe the same
suspect box from the same manager-box vantage point.

**Design decision this ticket left open, resolved here (and preserved
verbatim through the WYZR-28 rewrite): the three new probes do NOT get
their own host field.** They reuse `suspectBox.host` as their target — the
same suspect box the ssh direct path already points at. A second host
field would let an operator misconfigure the two to point at different
boxes with no error, and there is no legitimate reason for them to differ.
Consequence, STRENGTHENED by this rewrite: since `suspectBox.host` is now
a REQUIRED top-level value (rather than an independently-optional env
var), the uptime probe is **always** configured in any config that loads
at all — unlike the old env-var loader, where it could be left
unconfigured by leaving ssh unset. The daemon and fleet-audit checks still
independently gate on their own required-together pairs below, unchanged.

| Config key | Configures |
| --- | --- |
| `jira`, `github` | Outside-instrument resumption (check 4) — same sections as `wyzr wedge status`. |
| `suspectBox.host` | Reachability's ssh path (check 1) AND, by reuse, the target host for the reboot/daemon/fleet probes (checks 2/3/5). |
| `tunnelPing` | Reachability's tunnel-ping path (check 1). |
| `localConnectivity` | The shared-cause exclusion's target — same default (`1.1.1.1`) as `wyzr wedge status`. |
| `recovery.uptimeTimeoutMs` (optional) | Overrides the uptime probe's timeout — defaults to the reused `suspectBox.timeoutMs`. |
| `recovery.daemon` (optional section: `unit` + `scope` required together if present, `scope` must be exactly `"user"` or `"system"`) | The daemon check (check 3). `timeoutMs` defaults to `5000`. **A typo'd `scope` REFUSES, naming the value — it does not silently vanish into "unconfigured"**, unlike the old env-var loader (a deliberate, documented strengthening — see `src/config.ts`'s own top comment). |
| `recovery.fleetAudit` (optional section: `processMatch` + `expectedFlags` required together if present) | The fleet-pane audit (check 5). `timeoutMs` defaults to `5000`. |

Every optional section above may be omitted entirely — that check then
reports itself **UNCONFIGURED**, never a guess, same discipline as `wyzr
wedge status`. A section that IS present must be COMPLETE (e.g. `recovery.daemon`
with `unit` but no `scope` is a refusal naming `recovery.daemon.scope`,
never a half-configured daemon check).

### The `--json` contract

`RECOVERY_SCHEMA_VERSION` (`src/cli-recovery.ts`), starting at `1`,
following this repo's established per-command schema-version precedent —
additive-only.

```json
{
  "schemaVersion": 1,
  "command": "recovery status",
  "verdict": "UNCONFIGURED",
  "since": "2026-09-11T10:20:00.000Z",
  "elapsedMs": 100000,
  "checks": {
    "reachability": "not-configured",
    "reboot": "not-configured",
    "daemon": "not-configured",
    "instruments": "not-configured",
    "fleet": "not-configured"
  },
  "reasons": ["..."],
  "reachability": [{ "name": "ssh", "outcome": "not-configured", "note": "not configured — no operator-supplied host for this direct path" }],
  "localControl": { "name": "local-connectivity", "outcome": "healthy", "confirms": ["manager-internet"], "note": null },
  "uptime": { "outcome": "not-configured", "uptimeMs": null, "note": "not configured — no ssh host to read uptime from" },
  "daemon": { "outcome": "not-configured", "unit": null, "scope": null, "note": "not configured — no unit/scope supplied" },
  "instruments": [{ "name": "jira-activity", "outcome": "not-configured", "lastSeenAt": null, "note": "not configured — no operator-supplied target for this instrument" }],
  "fleet": { "outcome": "not-configured", "totalCandidates": null, "flaggedCount": null, "bareCount": null, "note": "not configured — no process-match/expected-flags supplied" }
}
```

Real output, not a hand-typed example — `reachability`/`instruments` are
each shown with ONE entry for brevity (both arrays have two: ssh/tunnel-ping
and jira-activity/github-activity respectively, identically shaped). It was
produced by running `evaluateRecovery()`/`toRecoveryStatusJson()` directly
against the same "everything unconfigured" inputs
`test/unit/cli-recovery.test.ts`'s corresponding case constructs — captured
2026-09-11, not asserted from memory.

| Field | Type | Meaning |
| --- | --- | --- |
| `verdict` | `"RECOVERED"` \| `"NOT_RECOVERED"` \| `"FLEET_HALF_RESTORED"` \| `"INCONCLUSIVE"` \| `"UNCONFIGURED"` | See "The verdicts and their precedence" above. |
| `checks.*` | `"pass"` \| `"fail"` \| `"could-not-look"` \| `"not-configured"` | Each of the five checks' own outcome — lets a caller reason about WHICH check drove the verdict, not just the verdict itself. |
| `reachability[].outcome` | `"alive"` \| `"dead"` \| `"unconfirmed"` \| `"not-configured"` | Per direct path (ssh, tunnel-ping) — see "Direct paths" in `wyzr wedge status`'s own section for what these mean at the raw-probe level. |
| `daemon.unit` / `daemon.scope` | `string \| null` | Which unit and scope were actually examined, so a reader can tell what this check looked at — never omitted when configured. |
| `fleet.totalCandidates` / `.flaggedCount` / `.bareCount` | `number \| null` | COUNTS ONLY — see "The fleet-audit redaction boundary" above. Always reported together. |
| `note` (every sub-object) | `string \| null` | Fragment-safe — never any part of a raw response value, a credential, a pid, a session id, or a raw command line, on any path (same rule as `wyzr wedge status`'s own contract). |

This is allowlist-projected by `src/cli-recovery.ts` from this module's
internal `RecoveryResult` shapes — never a raw spread of them, which carry
an internal `__brand` discriminant on every observation that has no
business in a published API.

### Tests

Every named test the ticket requires exists in `test/unit/recovery.test.ts`
(the pure-engine cases: the reboot check's skew-safety in both directions, a
flickered-plug-without-restart failure, the plug-liveness type exclusion and
its behavioral counterpart, FLEET_HALF_RESTORED as its own reachable
verdict, the daemon check's four-way distinction, no check's pass inferred
from another's, the instrument-resumption trap, the local-connectivity gate
on silence in both directions, RECOVERED's unreachability under any
unconfigured/unreadable check, and the UNCONFIGURED-vs-INCONCLUSIVE
distinction — each named for what it pins, per the ticket's own requirement),
`test/unit/recovery-probes-real.test.ts` (the pure classifiers —
`parseUptimeSeconds`, `classifyDaemonOutput`, `classifyFleetProcesses`,
including the session-id-shaped-string redaction test at both the classifier
and the probe level, on the success AND the error path), and
`test/unit/recovery-imports.test.ts` (the structural read-only proof, watched
RED first — see above).

`src/recovery.ts` calls no ambient time source anywhere — same discipline as
`src/wedge.ts`. `RecoveryInput.now`/`.since` are the only time this module
ever sees, injected by its caller; real per-probe timeouts live in
`src/recovery-runner.ts`'s I/O layer, never in the engine.

### What has never been run against reality

**Nothing in this section has ever faced a real recovering box.** All three
new probes (`checkUptime`, `checkDaemon`, `checkFleetAudit`) are, like
everything device-facing in this repo, exercised only against
`FakeWedgeProbes`/`FakeRecoveryProbes` in this suite and against harmless
local fixtures at the classifier level — never against an actually-wedged
remote machine, a real systemd unit over ssh, or a real fleet pane.
Specifically:

- **`/proc/uptime`'s shape** (a space-separated pair of floats, first field
  seconds since boot) is this project's own knowledge of the Linux kernel's
  documented `/proc` interface — never captured from this specific product's
  own suspect box, because this repo names no such host.
- **`systemctl show ... --property=LoadState,ActiveState`'s output shape**
  (`Key=Value` lines) is systemd's own documented behavior — never captured
  from a real run against a real unit on a real box.
- **The fleet-pane-audit's `ps -eo args=` shape**, and the entire
  enumeration-trap reasoning it is built on, is RELAYED from a real run
  against a real multi-agent box on 2026-09-10 (see "The herdr-restore trap"
  above) — real, but relayed, not independently re-measured by this repo's
  own authors, and the relayed run itself could not confirm how long a bare
  pane persists before exiting (see the ticket's own honesty limits on that
  measurement).
- **The reboot check's skew-safety property** is proven mathematically
  (a pure duration comparison, verified by unit tests covering both skew
  directions) but has never been checked against a real box whose clock is
  actually wrong.

A green suite here proves this code matches this project's own belief about
`/proc/uptime`, `systemctl show`, and `ps`'s output shapes; it **cannot**
prove those beliefs are correct on every Linux distribution/systemd version
an operator might run. Like `wyzr wedge status` before it, this command
cannot be exercised against reality by any agent in this fleet — see the
epic's own "no agent can ever run this product" ruling.

## `wyzr cycle`

The destructive verb (WYZR-19/WYZR-27): cuts MAINS POWER to the physical
box the whole agent fleet runs on, waits, and restores it. **There is no
graceful drain, no confirmation from the far side, and no undo.** Everything
above this section in the README is read-only; this one command is not.

```sh
wyzr cycle <device>              # gated, live — refuses unless the gate is PROVEN
wyzr cycle <device> --dry-run    # the ONLY way to exercise this verb's judgment
                                  # without cutting power — see "Dry-run" below
wyzr cycle <device> --force-override-gate-verdict-i-accept-the-risk \
  --force-non-interactive-confirm-target=<configured-target-host>
                                  # human-forced, non-interactive — see "Force" below
```

`<device>` is resolved the same way, through the same code
(`src/device-resolve.ts`), as `plug status|on|off` — exact mac or exact name,
case-insensitive, never a guess between ambiguous matches. This verb does
not assume one device equals one switchable outlet either; nothing here
invents a second resolution path.

### The sequence, and why it is a procedure, not a single verdict function

`src/wedge.ts`'s `evaluateWedge()` and `src/recovery.ts`'s
`evaluateRecovery()` are each a single pure function: gather everything,
decide once. `wyzr cycle` is not that shape — it is a PROCEDURE with real
actions gated at specific points, so `src/cycle-runner.ts` follows
`src/wedge.ts`/`src/wedge-runner.ts`'s injectable-boundary discipline
(gate, plug transport, recovery verifier, and clock all injected; every
path exercisable at zero network, zero credentials, zero real writes)
without forcing the whole thing into one `evaluate(input)` call. Two pieces
ARE extracted as genuinely pure: `src/cycle.ts`'s `decideGate()` (switches
on the gate's verdict VALUE, never reconstructs one from text) and
`src/cycle-wrong-box.ts`'s own pure-engine/impure-runner pair,
`evaluateWrongBoxGuard()`/`runWrongBoxGuard()` (the guard resolves real
network-address evidence through its own injectable
`WrongBoxIdentityProbe` boundary — see "The wrong-box guard" below for why
a hostname-string comparison alone can never be made to work here).

The sequence, every step recorded as its own evidence-trail entry (never
collapsed into a boolean — the same "evidence is the product, the verdict
is a summary of it" discipline as `WedgeResult.reasons`/
`RecoveryResult.reasons`):

1. **Evaluate the gate** — `src/wedge-runner.ts`'s `runWedgeCheck()`,
   COMPOSED, never reimplemented or re-derived. `wyzr cycle` switches on the
   verdict VALUE only.
2. **Wrong-box guard** — see below. Runs unconditionally, on every path.
3. **Cloud + plug-state preconditions** — see below. Also runs
   unconditionally, regardless of what the gate or the guard already
   decided.
4. **OFF** (only if every check above cleared, or the gate's own refusal was
   overridden by a satisfied force) — see "The D1 asymmetry" below.
5. **Wait** — a configured pause before the restore begins.
6. **ON, the never-give-up restore** — see below.
7. **Recovery verdict** — `src/recovery-runner.ts`'s `runRecoveryCheck()`,
   COMPOSED, never reimplemented, `since` set to the OFF instant captured
   from the injected clock at the moment OFF was attempted (a wedged box
   cannot be read BEFORE the cut, so the cut instant is the only baseline
   that always exists — same reasoning `recovery status --since` documents).
8. **Report** — human or `--json`, one evidence trail, one verdict.

All three preamble checks (gate, wrong-box guard, preconditions) are
evaluated on EVERY run, dry or live, never short-circuited — this is what
lets a refused dry run show the FULL picture (R5's own bar: "someone must
be able to watch the gate decide NO on a healthy box and see exactly why"),
and what makes `wyzr cycle --force ...` still refuse when the cloud is
unreachable even though force would otherwise have overridden the gate's
own NOT_PROVEN verdict (the single most important test in this story — see
"Force" below). **When more than one preamble check would refuse, the
REPORTED outcome follows this priority: wrong-box guard, then
preconditions, then the gate.** Deliberate, not arbitrary: the wrong-box
guard gets "no escape hatch, anywhere, under any flag" (stronger language
than the preconditions get), and the preconditions are a CAPABILITY force
can never touch, while the gate's own refusal is the one thing force CAN
override — reporting weakest-to-strongest (gate last) means the outcome you
see is always the strongest reason the run could not proceed, never a
weaker one masking a stronger one force could not have fixed anyway.

### The D1 asymmetry — refuse before the cut, never give up after it

**Before the OFF:** cloud reachability and a readable plug state are an
affirmative PRECONDITION, checked IMMEDIATELY BEFORE acting
(`src/cycle-preconditions.ts`'s `evaluatePreconditions()`). One
`PlugReader.readState()` call decodes both halves at once: reaching a
decodable `get_property_list` response requires having reached Wyze's
cloud API at all (login and the device-host call both succeeded), and both
P3 and P5 decoding is `src/plug.ts`'s own "state known" rule, reused rather
than re-derived. If the cloud cannot be reached, or the plug's state cannot
be read, `cycle` REFUSES and cuts nothing — **the power-off is the point of
no return, and an operator who cannot turn the plug back ON must never be
allowed to turn it off.**

**After the OFF, the box is already dark and refusing helps nobody.** The ON
is retried — bounded, with a real timeout, explicit, loud, never silent
(`src/cycle-runner.ts`'s `performRestoreNeverGiveUp()`), entirely behind the
injected `CycleClock` (`src/cycle-clock.ts`) — **no real-timer sleep
anywhere in this repo's suite**, and no default clock anywhere in
`src/cycle-runner.ts` (an omitted `clock` is a compile error, not a
fallback to a real timer). If the restore cannot be confirmed within the
configured bound, `wyzr cycle` exits on its own distinct code (`21`,
`cycle_stranded`) whose message states plainly: power is OFF, the restore
was NOT confirmed, and the exact single command that restores it by hand
(from `cycle.handRestoreCommand` — configured, never invented). This
is the loudest thing in the product, and it is NEVER reported as success.

**Why the OFF write is at most once, ever, while the ON may be retried
(R1) — two reasons, and the second is the important one.** (i) A
contradicted or unreadable OFF read-back is equally consistent with a write
that WORKED, so a second blind OFF would act on a plug that may already
have switched — redundant. (ii) **Far worse than redundant: if the plug DID
switch and the box has begun to boot, a second OFF cuts power to a machine
MID-BOOT** — an unclean power loss during startup, on the box carrying the
whole fleet. So the OFF/ON asymmetry is not "one is redundant and one is
necessary"; it is that a retried OFF has a failure mode the FIRST OFF does
not have at all. `src/cycle-runner.ts`'s `performOff()` carries this same
reasoning in its own comment, on purpose — a future reader must be able to
re-derive why, not take the asymmetry on faith. A THROWN `set_property`
call is treated the same way: a thrown write cannot be distinguished from
one that LANDED at Wyze with a lost response, so "the write failed, so
nothing happened, so I can exit" is never a safe conclusion — the restore
always runs next regardless of how the OFF's own write or read-back
resolved (R2). `src/plug.ts`'s existing `classifyWriteOutcome()` (the
`confirmed`/`unconfirmed`/`contradicted` three-way split from `plug on/off`)
is reused verbatim for both the OFF's and every ON attempt's own read-back
classification — nothing here re-derives it.

**Every read-back — OFF's and each ON attempt's — is a BOUNDED RETRY before
any conclusion (R3), driven by the injected clock.** Propagation was
measured exactly once, n=1, about three seconds, one plug, one network, by
hand — **that is not a latency budget**, and no sleep anywhere in this verb
is tuned to it; the poll interval and the bound are both plain, configured,
round-number defaults (see "Configuration" below), documented as exactly
that.

### The wrong-box guard (D7) — four rounds to get right, and why

`cycle` must REFUSE when the machine it runs on is the machine it is about
to cut. **There is no "run it from the fleet box" escape hatch, anywhere,
under any flag** — `src/cycle-wrong-box.ts`'s `runWrongBoxGuard()` runs
unconditionally, before this verb ever acts on the gate's verdict or the
preconditions, on every path including `--force` and `--dry-run` (dry-run
REPORTS its finding rather than skipping the check).

**This guard went through four rounds before it was right, and the history
is worth keeping — it is a small, self-contained instance of exactly what
this epic exists to catch.**

- **Round 1** compared a configured hostname string to the local hostname,
  normalised (trim, lowercase) and special-cased an FQDN against its own
  short form as a match. Review caught, by MEASUREMENT before inspection,
  that documenting this as "every unresolvable case refuses" was FALSE: a
  DNS-alias/CNAME divergence and a container/VM hostname divergence both
  produced `"not_target"` (PROCEED). The epic overturned the proposed
  doc-only fix: **the code was wrong, not the docs** — a guard that fails
  open on the exact case D7 exists to prevent is not fixed by describing
  the hole accurately.
- **Round 2** tried a cleverer string rule: compare only when both
  identities are the same "kind" (a plain hostname, an FQDN sharing a
  domain, an IP literal, a container-shaped hex id), refuse on every
  cross-kind pairing. **Also wrong, caught the same way — by running it
  against the epic's own worked example, not by inspecting the rule.**
  `("physicalhost", "a3f9c21b4e77")` — the container-vs-hostname row the
  correction was ABOUT — is indistinguishable in shape from two genuinely
  different hosts. **The epic's actual finding: no pure function over two
  STRINGS can rule this out.** The information needed to tell them apart
  is not present in the two inputs, no matter how the comparison rule is
  written — making the string rule cleverer was never going to close this.
- **Round 3, what ships:** if a pure function cannot resolve identity, it
  must not be the thing that clears the box. `src/cycle-wrong-box.ts` now
  has a PURE decision core (`evaluateWrongBoxGuard()` — zero I/O,
  exhaustively testable, decides nothing it wasn't handed) and an
  injectable identity-resolution boundary (`WrongBoxIdentityProbe`,
  `runWrongBoxGuard()` is the thin async runner that gathers evidence
  through it) that supplies REAL evidence instead: this machine's own
  network addresses (`getLocalAddresses()` — `os.networkInterfaces()`,
  purely local, zero network I/O) and the configured target's own
  addresses, resolved FROM THIS MACHINE (`resolveTargetAddresses()` — a
  DNS/hosts-file lookup). Same pure-engine/injectable-I/O split this repo
  already uses everywhere else (`src/wedge.ts` vs `src/wedge-probes.ts`).
  `"is_target"` requires at least one address to appear in BOTH sets;
  `"not_target"` requires both sets to resolve successfully and be
  disjoint; anything else — resolution failure, an empty local-address
  set, an unconfigured target — is `"inconclusive"`, exactly the
  first-class "could not look" shape `src/wedge.ts`/`src/recovery.ts`
  already report elsewhere.
- **Round 4** — round 3 disclosed "IPv6 representational variance is not
  normalised" as a residual limitation, filed next to genuine probe
  failure as if they were the same kind of gap. **They are not, caught
  again by MEASUREMENT — a real Linux host, not an argument.** (a) A
  target resolving to a LOOPBACK address could never overlap
  `getLocalAddresses()`'s own loopback-EXCLUDING set (loopback is excluded
  from the local set because every machine shares it, so it never
  distinguishes anything) — and Debian/Ubuntu's OWN DEFAULT `/etc/hosts`
  maps a machine's hostname to `127.0.1.1`, which `dns.lookup()` (this
  module's resolver, chosen BECAUSE it consults `/etc/hosts`) duly returns.
  So `wyzr cycle` run ON the target, configured EXACTLY per this section's
  own guidance, resolved `not_target` and PROCEEDED — fail-open on
  precisely the case this guard exists to catch, on a distro default, not
  an edge case. **Fixed:** any loopback address (`127.0.0.0/8`, `::1`) the
  TARGET resolves to is now unambiguous evidence this machine IS the
  target, decided independently of `localAddresses` entirely — a loopback
  address can only ever mean "the machine that asked," never any other
  machine, however its own non-loopback interfaces are configured. (b) An
  IPv4-mapped IPv6 spelling (`::ffff:10.0.0.5`) against its plain IPv4
  form, and two differently-compressed spellings of the SAME IPv6 address,
  are not a "cannot resolve" gap at all — **they are the identical address,
  spelled two ways, the same class of problem as the hostname trim/
  lowercase this guard already did.** Fixed: every address is reduced to
  one canonical form (`canonicaliseAddress()`) before any comparison.

**The constraint this mechanism was checked against before it was built:**
this verb exists for the case where the far box is DEFINITIVELY GONE — when
the gate says PROVEN, the target does not answer network traffic, by
construction. Any identity mechanism that needs the TARGET to answer (ssh
to it, ping it, ask it its own machine-id) would report "could not look"
and REFUSE exactly when this verb is needed — this epic's own denominator
trap in a third shape, an instrument whose construction excludes the case
it exists to serve. `resolveTargetAddresses()` never contacts the target:
DNS/hosts-file resolution is answered by the MANAGER's own resolver
configuration, which requires the target to have a stable address on
record, never that it be reachable or powered on right now.

**Operational requirement this places on deployment, stated here rather
than assumed:** the configured target (`suspectBox.host` — REQUIRED, no
default; also the wrong-box guard's own target, deliberately the SAME
field as the ssh direct path's, see "Configuration" below) must resolve,
from the machine `wyzr cycle` runs on, to that target's real address(es)
— via DNS or a static `/etc/hosts` entry — independent of whether the
target is currently
up.

**What this still cannot detect, and does not claim to:** multi-homed or
NAT'd addressing this machine's own resolver does not know about at all —
a genuine "the information is not in the inputs" gap, not a normalisation
problem (not the same class as round 4's fix); and, structurally, any case
where either probe call fails or returns nothing — those are
`"inconclusive"`, never guessed. Address-set overlap (now over
canonicalised addresses, with loopback resolved as its own special case)
is real evidence a string comparison could never be — it is not
omniscience.

### Force (D4) — overrides the VERDICT, never the PRECONDITIONS, and never the wrong-box guard

`decideGate()` (`src/cycle.ts`) implements the rule exactly: when the gate
says PROVEN, `cycle` acts with no extra ceremony (D5 — "ceremony in the one
case the product exists for is a design failure"). When the gate says
NOT_PROVEN or INCONCLUSIVE_BY_SHARED_CAUSE and the run is human-forced, the
JUDGMENT is overridden and the run proceeds PAST THE GATE — but the
wrong-box guard and the preconditions are evaluated completely
independently of that decision, and either can still refuse. **No human
certainty makes an unreachable cloud reachable, and forcing past it would
produce exactly the stranding this epic exists to prevent.**

**This is made STRUCTURAL, not conventional.** A boolean parameter threaded
through a function (`skipPreconditions: true`) is not structural — someone
adds it next year and nothing breaks. Instead, `src/cycle-preconditions.ts`
exports a `PreconditionsClearedWitness` type whose brand key is a
MODULE-PRIVATE `unique symbol`, never exported — no file outside that
module can even NAME the property this type requires, let alone construct
one, short of an explicit, visible `as unknown as PreconditionsClearedWitness`
type-cast a reviewer would have to wave through. `src/cycle-runner.ts`'s
`performOff()` REQUIRES one of these as a parameter, so "skip the
preconditions and cut power anyway" is not expressible by adding a flag
anywhere in this codebase. This is stronger than this repo's existing
`__brand: "some-literal-string"` convention (`src/wedge.ts`/
`src/recovery.ts`) — a string-literal brand is still a property anyone can
spell and assign; a non-exported unique-symbol key cannot be spelled by any
code outside the module that declares it at all. Pinned at the type level
in `test/unit/cycle-preconditions.test.ts` (a bare object literal does not
satisfy the type — verified by removing the `@ts-expect-error` directive
and observing `bun run typecheck` report a new missing-property error at
that line before restoring it) and exercised behaviorally in
`test/unit/cycle-runner.test.ts`'s "force + gate NOT_PROVEN + cloud
unreachable -> STILL REFUSES" test — the most important test in this
story, because it is the one that would catch a future change that
accidentally let force reach past the precondition.

**Force requires all of:** a long, explicit, self-describing flag that
cannot be hit by accident or pasted reflexively
(`--force-override-gate-verdict-i-accept-the-risk`); the FULL evidence
trail and verdict printed BEFORE acting (`src/cli-cycle.ts` runs the
UNFORCED dry-run preview first, prints it in full, and only then asks for
confirmation — re-evaluating the preamble a second time when the real run
follows is not wasted work, since D1 requires the precondition to be
checked "immediately before" the OFF, and real time has passed while the
operator read the preview); an interactive confirmation NAMING THE TARGET
(typing the exact configured target host back); and a SEPARATE flag for the
genuinely non-interactive case
(`--force-non-interactive-confirm-target=<target>`) — **the force flag
alone is never sufficient** (a `--force` with no satisfied confirmation
refuses with a Usage error, never proceeds). Output records `forced: true`
and the full evidence the force decision was made against.

### Dry-run (R5) — a primary deliverable, not a flag

**No agent in this fleet can ever execute this verb end to end** — every
live run is a human on a different machine who CANNOT ask a follow-up
mid-run. Dry-run is the ONLY way anyone exercises this verb's judgment
without cutting power to the whole fleet, and **the bar it must meet:
someone must be able to watch the gate decide NO on a healthy box and see
exactly why.** That is what earns this verb the right to ever decide YES.

`src/cycle-runner.ts` exposes TWO entry points, not one function with a
`dryRun: boolean` parameter: `runCycleDryRun(plug: PlugReader, ...)` and
`runCycleLive(plug: PlugWriter, ...)`. `PlugReader`
(`src/cycle-plug.ts`) exposes only `readState()`; `PlugWriter` extends it
with `writePower()`. A write call anywhere inside `runCycleDryRun()`'s body
does not typecheck, because the parameter's static type has no such
method — **structurally incapable of writing on every path, including
force**, not a runtime `if (dryRun) return`. Both entry points share the
same preamble (gate, wrong-box guard, preconditions), which itself only
ever touches `PlugReader.readState()` — the precondition check is a READ on
every path, dry or live.

A dry run that WOULD refuse reuses the exact same refusal code a live run
would produce (17/18/19) — a refusal is a refusal, dry or not, since
neither path ever writes on that outcome. **`wyzr cycle --dry-run` gets its
OWN distinct code (`20`, `cycle_dry_run_would_act`) only for the
complementary case: every check cleared, so a live run at this exact
moment would have proceeded to cut power.** This is the deliberate answer
to "how does a script tell 'dry run: would refuse' from 'dry run: would
act'" — reusing the refusal codes rather than minting three more (one per
refusal class) keeps a script that already knows 17/18/19 from `wyzr cycle`
immediately correct for a dry run too, and a single new code is all that is
needed to name the one case those three cannot already distinguish.

### Post-cycle verification (D6) — composed, never reimplemented, and a confirmed plug is never enough

**A cycle that ends without a recovery verdict is not a completed cycle.**
Once the never-give-up restore confirms the plug reads "on",
`src/cycle-runner.ts` ALWAYS calls `src/recovery-runner.ts`'s
`runRecoveryCheck()` next — the plug confirming "on" is never, on its own,
reported as success. `since` is the OFF instant captured from
`CycleClock.now()` at the moment OFF was attempted, exactly as
`recovery status --since` requires.

The five recovery verdicts map to their own `cycle`-specific exit codes
(22-25 above) rather than reusing 13-16: `src/errors.ts`'s own comments on
13/15/16 document those three as "`wyzr recovery status` only," so reusing
them here would silently break the scope those comments already promise —
this file's own rule is that an existing entry is never reordered, reused,
or modified. RECOVERED is the one exception, reusing exit `0` by symmetry
with `recovery status`'s own RECOVERED.

**No plug-liveness reading may stand in for a recovery verdict** — this
verb is the FIRST caller who actually holds a real `PlugReading` (from its
own precondition check and its own OFF/ON read-backs) and could, in
principle, be tempted to smuggle one into the recovery engine's evidence.
It cannot: `src/recovery-runner.ts`'s `RunRecoveryCheckOptions` has no field
a plug reading could occupy at all, and `src/recovery.ts`'s
`PlugLivenessReading` remains structurally excluded from every recovery
evidence collection (see "`wyzr recovery status`" above). Pinned AGAIN,
independently, in `test/unit/cycle-runner.test.ts` — not only by relying on
`recovery.test.ts`'s own existing pin — because this is the module the
epic named as the realistic party who would find a way to pass one in.

### The `--json` contract

`src/cycle-report.ts`'s `CycleJson` (schema version `1`, `command: "cycle"`)
— allowlist-projected, never a raw spread of `CycleResult`'s internal
shapes (which carry `__brand` fields and, for `preconditions`, the witness
machinery that has no business in a published API). The `gate` and
`recovery` sections are rendered by REUSING `src/cli-wedge.ts`'s
`toWedgeStatusJson()` and `src/cli-recovery.ts`'s `toRecoveryStatusJson()`
verbatim — composed, not reimplemented, the same rule the ticket applies to
the engines themselves. Top-level shape:

```jsonc
{
  "schemaVersion": 1,
  "command": "cycle",
  "outcome": "refused_by_gate" /* | refused_by_wrong_box_guard | refused_by_precondition
                                  | would_act | stranded | recovered | not_recovered
                                  | fleet_half_restored | recovery_inconclusive
                                  | recovery_unconfigured */,
  "dryRun": false,
  "forced": false,
  "reasons": ["..."],           // the full ordered evidence trail
  "gate": { /* WedgeStatusJson, unchanged shape — see "wyzr wedge status" */ },
  "wrongBoxGuard": { "outcome": "not_target", "reasons": ["..."] },
  "preconditions": { "outcome": "cleared", "power": "on", "reachable": true, "note": null },
  "off": null,                  // populated once OFF is attempted: writeThrew, writeErrorMessage,
                                 // readBacks[] (attempt/atMs/result/power/reachable/note), finalResult
  "restore": null,              // populated once the restore runs: attempts[] (each shaped like off,
                                 // plus attempt/atMs), confirmed, elapsedMs
  "recovery": null,             // populated only once the restore is confirmed: RecoveryStatusJson,
                                 // unchanged shape — see "wyzr recovery status"
  "handRestoreCommand": null    // populated only for outcome === "stranded"
}
```

### Configuration

**WYZR-20/WYZR-28: the ONE file-backed configuration surface, read by
`wyzr wedge status`, `wyzr recovery status`, and `wyzr cycle` alike.**
`src/config.ts`'s `loadWyzrConfig()` loads, validates, and returns the
whole thing from `<XDG_CONFIG_HOME or $HOME/.config>/wyzr/config.json` —
the SAME XDG rule `src/credentials.ts` uses for `credentials.json`, reused
rather than reimplemented. The CLI reads **nothing** from the environment
for configuration; the previous provisional `WYZR_WEDGE_*`/`WYZR_RECOVERY_*`/
`WYZR_CYCLE_*` env-var loaders are gone. A dedicated test
(`test/unit/config.test.ts`, "no `WYZR_*` environment variable influences
the loaded config") sets a plausible env var, loads a config from a
fixture file, and asserts the env value never appears in the result.

**Why one surface, not two, ratified explicitly for this ticket:** the old
env loaders let `wedge-config` (which box is wedged) and `cycle-config`
(which plug to cut) disagree with no error — the worst outcome this
product can produce is proving box A is wedged and cutting power to box
B. A single validated file removes that possibility structurally, not by
operator discipline.

**Refusal discipline (the loader's own contract, mirroring
`src/credentials.ts` exactly):** a missing config file, an over-permissive
directory or file (`mode & 0o077`, checked directory-then-file), unparseable
JSON, an unknown top-level field, a missing/mistyped required value, or a
present-but-incomplete optional section are ALL refusals — one exit code,
`ExitCode.ConfigInvalid` (26), distinguished by a `reason` string (same
precedent as `ExitCode.CredentialsInvalid`). **No error path this loader
produces ever echoes a config value, a hostname, a mac, or a secret
fragment** — every message names only a field/section path and the config
file's own path. `docs/config.example.json` is a complete, placeholder-only,
genuinely-loadable example of every required key and every optional
section (a test loads it directly, guarding against the example drifting
out of sync with the schema); `.gitignore` makes an accidental
`/config.json` in the repo root impossible to commit.

**The full schema:**

| Config key | Required? | Meaning | Default when omitted |
| --- | --- | --- | --- |
| `suspectBox.host` | **Required** | The suspect box's ssh direct path target — see `wyzr wedge status`'s own "Configuration" section. **Also the wrong-box guard's configured target, and the reused host for the reboot/daemon/fleet probes** — deliberately ONE field, not three, so they can never diverge (see below). Must RESOLVE from the machine `wyzr` runs on (DNS or a static hosts entry), independently of whether the target is powered on — a real deployment constraint, not a suggestion (see "The wrong-box guard" above). | none — required |
| `suspectBox.timeoutMs` / `.connectTimeoutMs` | optional | The ssh probe's own budget / connect-timeout. | 5000 / 3000 |
| `tunnelPing` (section) | optional | The tunnel-ping direct path — see `wyzr wedge status`. | unconfigured |
| `jira` / `github` (sections) | optional | Outside-instrument resumption — see `wyzr wedge status`. | unconfigured |
| `localConnectivity` (section) | optional | The shared-cause exclusion's target/timeout. | target `1.1.1.1`, timeout `5000` |
| `controlPlane` (section) | optional | The control-plane reading — see `wyzr wedge status`. | unconfigured |
| `recovery.uptimeTimeoutMs` | optional | Overrides the reused uptime probe's timeout. | `suspectBox.timeoutMs` |
| `recovery.daemon` (section) | optional | The daemon check — see `wyzr recovery status`. `scope` must be exactly `"user"` or `"system"` when present; a typo REFUSES rather than vanishing. | unconfigured |
| `recovery.fleetAudit` (section) | optional | The fleet-pane audit — see `wyzr recovery status`. | unconfigured |
| `cycle.handRestoreCommand` | optional | The exact, operator-facing command printed on a STRANDED outcome. | none — the message says so plainly instead of inventing a placeholder |
| `cycle.timing.offToOnWaitMs` | optional | Pause between the OFF attempt and starting the restore. | 5000 |
| `cycle.timing.offReadbackPollIntervalMs` / `.offReadbackBoundMs` | optional | The OFF read-back's own bounded retry (R3) — purely evidentiary; the restore always runs regardless of what this concludes (R2). | 2000 / 20000 |
| `cycle.timing.restoreReadbackPollIntervalMs` / `.restoreReadbackBoundMs` | optional | Each ON attempt's own bounded read-back retry. | 2000 / 20000 |
| `cycle.timing.restorePollIntervalMs` | optional | Delay between successive ON write attempts in the never-give-up loop. | 10000 |
| `cycle.timing.restoreTimeoutMs` | optional | The OUTER bound on the whole never-give-up restore — past this, STRANDED. | 300000 (5 minutes) |
| `fleetPlug` (`mac` + `model` + `name`, `subDeviceId` optional) | **Required** | The plug on the cord of the box the whole fleet runs on. | none — required |
| `safePlug` (same shape) | **Required** | A deliberately-chosen, DIFFERENT plug a later task will rehearse a real write against. | none — required |

**Defaults are permitted ONLY for the fields marked above: timeouts,
quiet thresholds, the local-connectivity target, and the cycle timing
bounds.** None of the timing defaults is derived from the ticket's own n=1
propagation measurement (~3 seconds, one plug, one network, by hand) — R3
is explicit that this is not a latency budget. They are plain, round,
operator-tunable starting points, stated here as exactly that. **A
malformed but PRESENT value in any of these fields REFUSES — it does NOT
silently fall back to the default**, e.g. `suspectBox.timeoutMs: "abc"` or
`cycle.timing.restoreTimeoutMs: -5` both refuse naming the field. Only a
genuinely ABSENT field gets the documented default. (This is a deliberate
strengthening over the removed env-var loaders' `positiveIntMs()`, which
fell back to the default for a malformed value too — defensible for a
string-only env var, not for a validated JSON file; see `src/config.ts`'s
own top comment for the full reasoning.)

**Secrets vs. identifiers.** `jira.authHeader` and `github.token` are
registered with the redaction registry (`src/redact.ts`) before the loader
returns, exactly like `src/credentials.ts`. Hostnames, mac addresses, and
plug names are deliberately NEVER registered — they must stay legible in
the diagnostics an operator reads on their own screen during an outage; a
mistaken refusal with its addresses scrubbed would be undiagnosable.

### The fleet plug and the safe plug — structurally impossible to conflate

**A write rehearsal (a later task) pointed at the fleet plug is the worst
outcome this story could produce.** `fleetPlug` and `safePlug` are not
merely two same-shaped config sections: `src/config.ts` brands them as
`FleetPlugTarget` and `SafePlugTarget`, two structurally unrelated
TypeScript types, using the exact same technique
`src/cycle-preconditions.ts`'s `PreconditionsClearedWitness` already
established in this repo — a MODULE-PRIVATE `unique symbol` key that no
code outside `src/config.ts` can even spell, let alone forge, short of an
explicit `as unknown as SafePlugTarget` lie a reviewer would have to wave
through. `test/unit/config.test.ts` pins this with a `@ts-expect-error`
assignment of a real `FleetPlugTarget` where a `SafePlugTarget` is
required — mutation-tested (the directive removed, `bun run typecheck`
observed to fail with `TS2741` at that exact line, the file's own
`git diff --stat` confirmed changed, then restored).

**The config is also refused, at LOAD TIME, when the fleet plug and the
safe plug resolve to the SAME device** — identical `mac` and identical
`subDeviceId` (or both absent), after trim/lowercase normalization. This
check cannot see two different mac addresses that happen to name the same
physical device (an operator data-entry duplicate), nor a sub-device
relationship the config never expressed via `subDeviceId` — it is a
syntactic equality check over configured identifiers, not device
introspection; see `src/config.ts`'s `samePlugIdentity()` for this stated
in code.

**The sub-device requirement.** Relayed ground truth (not measured by this
repo): the fleet box's plug is a plain `Plug` (model `WLPP1CFH`, itself a
configuration VALUE — never hard-coded) with no `-SUB` children, while an
`OutdoorPlug` (model `WLPPO`) DOES have `-SUB` children, where the
addressable switchable thing is a SUB-DEVICE, not the device itself. Both
`fleetPlug` and `safePlug` carry an optional `subDeviceId` for exactly this
case — `null` means "this plug target IS the addressable device"; a
non-null value names which sub-device is the actual switchable target.
That a sub-device is separately addressable this way is RELAYED, not
measured by this repo.

### Tests

Every one of the ticket's seventeen named refusal/behaviour tests exists in
`test/unit/cycle-runner.test.ts`, each its own named test, and — per the
epic's widened scope for R6 — each one proves the run actually REACHED the
decision point it is named for (a fake's own call counter, the composed
engine's own verdict surfacing in the result, or an evidence-trail line
only that step could have produced), not merely that it produced the
right-shaped outcome. `test/unit/cycle.test.ts` covers the pure
`decideGate()` decision in isolation; `test/unit/cycle-wrong-box.test.ts`
covers the pure `evaluateWrongBoxGuard()` core (address overlap/disjoint/
unresolvable, including the epic's own container-vs-hostname worked example
now correctly resolvable through address evidence — the round-2 regression
pin that a string-shape-only rule can never come back — and the round-4
regression pins: a target resolving to loopback still reaches `is_target`
even though the local set excludes loopback, and two differently-spelled
forms of the identical address — IPv4-mapped IPv6 against plain IPv4, and
two IPv6 compressions — compare equal), `runWrongBoxGuard()`'s concurrent
probe-gathering, and `RealWrongBoxIdentityProbe`'s DNS/network-interface
classification with both real (localhost/this machine's own interfaces)
and injected-failure calls; `test/unit/cycle-preconditions.test.ts`
covers the witness's structural pin; `test/unit/cycle-clock.test.ts` proves
no real timer ever runs and that omitting the clock is a compile error;
`test/unit/cycle-config.test.ts` and `test/unit/cycle-report.test.ts` cover
config loading and the `--json`/human rendering; `test/unit/cli-cycle.test.ts`
covers argument parsing and the force ceremony end to end, including one
full live cycle that actually exercises `RealCyclePlugTransport`'s
`readState()`/`writePower()` through a simulated plug (a mutable P3 the
fake transport's `setPropertyHandler` updates and `getPropertyListHandler`
reflects back) — real request/response shaping, zero network.

No message, note, reason string, or `--json` field anywhere in this verb
attributes a WHY to a failure it did not observe — a thrown read/write
error's message is relayed VERBATIM into the evidence trail, never
re-interpreted (pinned in `test/unit/cycle-runner.test.ts`'s "no failure
code is reasoned backwards to a cause" test).

### The honesty split — what this verb stands on, and what it does not

**THE READ PRIMITIVES ARE LIVE-PROVEN AS OF 2026-09-11**, through this
repo's own code, against a real account, at the approved sha: `devices
list` (sixteen rows matching an earlier hand measurement mac-for-mac),
`devices list --json`, and `plug status` on two real plugs, all exit `0`
with correct states. So login, the auth-host envelope decode, the
device-host body, the `get_property_list` field names, and the P3/P5
string decoding are exercised end to end — **this verb's PRECONDITION check
stands on proven primitives**, since it is exactly one such read.

**THE WRITE PRIMITIVES HAVE NEVER BEEN EXERCISED BY THIS CODE. NOT ONCE, BY
ANYONE, EVER.** `plug on`/`plug off` were deliberately NOT run in that
acceptance. The `set_property` field names and `pvalue` string typing were
measured BY HAND in Python and this code ships those names, but no write
has gone through `wyzr` itself. **`wyzr cycle` is off-then-on and is built
ENTIRELY on the unexercised half.**

**NO CYCLE HAS EVER BEEN RUN BY THIS CODE AGAINST A REAL PLUG OR A REAL
BOX.** A human pulled this lever once, by hand, outside this product, and
the box came back — that establishes the plug controls the box's power and
that cutting it does not brick it. **It establishes NOTHING about this
repo's code.** Evidence, not coverage.

Every code path in this section — the gate, the wrong-box guard, the
preconditions, the OFF/wait/ON sequence, the recovery composition, both CLI
entry points — is exercised only against `FakeWedgeProbes`/
`FakeRecoveryProbes`/`FakeCyclePlugTransport`/`FakeWyzeTransport` in this
suite, per this ticket's own absolute rule: **no plug is switched by this
task, not the fleet plug, not a "safe" test plug, not to find out what
something powers.** A green gate here proves this code does what THIS
REPO believes the Wyze write API does; it cannot prove that belief is
correct. That first real write is WYZR-20's own deliberately staged
rehearsal, not this one.

## `wyzr doctor`

Answers exactly one question: **is this install actually able to pull the
lever?** Read-only, structurally — see "Structurally incapable of switching
a plug" below. Wired to the config `wyzr wedge status`/`recovery
status`/`cycle` already read (WYZR-20/WYZR-28); no subcommand, no flags
beyond `--json`.

```sh
wyzr doctor [--json]
```

### What it reports, each as its own row

- **`config`** — present, correctly permissioned, and complete. `--json`
  names which OPTIONAL sections (`tunnelPing`, `jira`, `github`,
  `controlPlane`, `recovery.daemon`, `recovery.fleetAudit`,
  `cycle.handRestoreCommand`) are configured, as booleans — never a
  configured value. No config file at all reads `not-configured` (a fresh
  install, before setup); a present-but-broken file (bad permissions,
  malformed JSON, an incomplete section, conflated plugs) reads `fail` — a
  DIFFERENT state, on purpose (see "The honesty split" below).
- **`credentials`** — present and correctly permissioned, same
  presence/position/permission discipline, same two-state split (missing
  vs. broken). Never a fragment of `email`/`password`/`keyId`/`keySecret`/
  `totpSecret` in any row this command produces.
- **`cloud` (a login attempt)** — did logging in with the configured
  credentials succeed? This command NEVER diagnoses WHY a login attempt
  failed — see "It never diagnoses why authentication failed" below.
- **The target plugs (`fleetPlug`/`safePlug`)**, each reported as TWO
  independent facts: `resolvable` (does this mac appear in the account's
  own device list?) and `readable` (does a fresh P3/P5 read decode?). Kept
  separate deliberately — a plug can be resolvable but momentarily
  unreadable, or (in principle) readable while a stale/paginated device
  list missed it; collapsing the two would hide exactly that kind of
  disagreement.
- **The outside instruments** (`jira-activity`/`github-activity`) —
  configured or not, and reachable or not, by their canonical names (the
  same names `wyzr wedge status`/`recovery status` already report, so a
  reader sees ONE consistent instrument identity across every command that
  touches it).
- **The wrong-box guard's verdict about THIS machine** — run for real
  (`src/cycle-wrong-box.ts`'s `runWrongBoxGuard()`, the exact function
  `wyzr cycle` itself calls, reused rather than re-implemented) and
  reported verbatim: `not_target`/`is_target`/`inconclusive` plus its full
  evidence trail. Run on the manager box, this should read `not_target` —
  an `is_target` result here is the single most consequential thing this
  command can discover, and it is never buried inside a generic
  "could not look."
- **What remains unproven** — see "The honesty split" below; this command
  states plainly what its own composition does and does not stand on,
  every run, not just on request.

### Three hard rules on what it may say

1. **"Could not look" is neither a pass nor a fail.** Every row above uses
   this repo's own four-way vocabulary (`pass`/`fail`/`could-not-look`/
   `not-configured`, `src/recovery.ts`'s `CheckOutcome`, reused rather than
   re-invented) — reused all the way up to the command's OWN verdict
   (`READY`/`NOT_READY`/`INCONCLUSIVE`/`UNCONFIGURED`), which follows the
   exact same precedence `wyzr recovery status` already established: a
   FAIL anywhere outranks a could-not-look, which outranks a
   not-configured gap, which outranks a clean READY.

   **The propagation rule this command adds on top, which `recovery
   status` never needed:** this command's checks genuinely NEST — no
   credentials means no login attempt is possible, no config means no plug
   identity is known — where `recovery status`'s five checks are each
   independently read over the network with no shared prerequisite chain.
   A check blocked ONLY because an earlier prerequisite was itself never
   configured reports itself `not-configured` too (nobody pointed it
   anywhere either); a check blocked because an earlier prerequisite was
   attempted and BROKE reports itself `could-not-look` (a real, existing
   problem is in the way, a different fact from "nobody set this up"). See
   `src/doctor.ts`'s `blockedByPrerequisite()` and its own top comment.

2. **It never diagnoses WHY authentication failed.** A Wyze auth error code
   cannot be reasoned backwards to a cause — `errorCode 1000` alone covers
   at least three distinct, indistinguishable causes (see "`wyzr wedge
   status`"'s credentials section and `src/wyze-errors.ts`'s own comment).
   This command reports only WHETHER a login attempt succeeded, and relays
   a failed attempt's thrown message VERBATIM — never re-interpreted, never
   narrowed to "this looks like a bad password." The same rule `wyzr cycle`
   already holds itself to for its own precondition failures.

3. **Human output and `--json`** both go through `src/output.ts`, the
   single output boundary, following this repo's `schemaVersion` contract
   (currently `1`). Exit codes append from `26` (see "Exit codes" above) —
   `27`/`28`/`29`, never reordering or reusing an existing entry.

### Structurally incapable of switching a plug

This is the one command in this repo that must READ a plug, so
`test/unit/recovery-imports.test.ts`'s own property (no import path to the
transport/auth layer AT ALL) is not available to it — copying that test
would produce a green signal blind to the failure it exists to catch, since
this command necessarily imports `src/auth-session.ts`/
`src/transport-http.ts`/`src/cycle-plug.ts`. **Three different checks
instead, each blind to what the other two catch:**

- **A compiler-enforced typing pin.** `src/doctor-plug.ts`'s
  `checkPlugReadable()` is typed to accept only `PlugReader`
  (`src/cycle-plug.ts`, reused — the exact type `wyzr cycle --dry-run`
  already relies on), never `PlugWriter`. A `writePower()` call inside a
  function whose parameter is typed `PlugReader` does not typecheck.
  Pinned adversarially with a mutation-tested `@ts-expect-error`
  (`test/unit/doctor-plug.test.ts`): removing the directive (or, as
  captured, widening the parameter's type to `PlugWriter`) makes
  `bun run typecheck` fail with `Unused '@ts-expect-error' directive`.
  **What this CANNOT see:** whether any OTHER file in this command's own
  dependency tree imports a write-capable module at all — this pin is
  entirely local to one function's own body.
- **An import-closure assertion** (`test/unit/doctor-imports.test.ts`,
  watched RED first by temporarily importing `src/cli-plug.ts`) proving no
  import path exists from `src/cli-doctor.ts` to `src/cli-plug.ts` (whose
  `runPlugWrite()` is unconditionally reachable by importing that file at
  all), `src/cycle-runner.ts`, or `src/cli-cycle.ts` — the modules that
  actually ORCHESTRATE a live write, as distinct from `src/cycle-plug.ts`
  itself (which this command legitimately imports for the `PlugReader`
  type, and which DOES define `writePower` — reachability of a module that
  merely DEFINES a write method proves nothing; only reachability of a
  module that WIRES one up matters here). A sanity floor
  (`reached.size > 15`, plus explicit checks that `auth-session.ts`/
  `transport-http.ts`/`cycle-plug.ts`/`cycle-wrong-box.ts`/`config.ts` ARE
  reached) guards against a broken walk passing for the wrong reason.
  **What this CANNOT see:** a write call reached through something OTHER
  than a static relative import (dynamic `import()`, a string-built
  specifier) — none exist in this repo today, but this check would not
  notice one appearing.
- **A source-level grep over a DERIVED file set** (`test/unit/doctor-no-write.test.ts`)
  for a `writePower(`/`.setProperty(` call site, with a line-count floor
  (>400). **This one was itself the subject of a review finding, fixed in
  this PR**: it originally scanned a HARDCODED four-file array
  (`doctor.ts`/`doctor-plug.ts`/`doctor-runner.ts`/`cli-doctor.ts`), which
  meant a brand-new fifth module reaching `writePower()` was invisible to
  it — measured live: a `src/doctor-extra.ts` exporting a `PlugWriter`-typed
  function that calls `plug.writePower("0")`, imported from
  `src/doctor-runner.ts`, passed typecheck AND all three checks (833 pass
  / 0 fail) before the fix. **The fix derives the scanned set from the same
  import-closure walk `test/unit/doctor-imports.test.ts` performs from
  `src/cli-doctor.ts`**, excluding only `src/auth-session.ts`/
  `src/cycle-plug.ts` (measured to be the entire set of legitimate
  `writePower`/`setProperty` DEFINERS in the 31-module closure) — this
  fails CLOSED: a new doctor-adjacent module is automatically IN the
  scanned set the moment it becomes reachable, with nobody having to
  remember to add it. Re-running the same attack against the fixed test
  now fails it, naming the exact file and line. **What this CANNOT see,
  even after the fix:** a write reached through a dynamic `import()`, a
  string-built specifier, an aliased or dynamically-constructed method
  name, or one hiding inside a module added to the definer allowlist for a
  reason other than legitimately defining the write boundary.

None of the three alone is the property; together they cover typing,
reachability, and literal call sites — three different failure shapes, not
one check run three times.

### The honesty split — what this command's own composition stands on

The same four-level split `wyzr cycle`'s own README section states, applied
to what THIS command specifically composes:

1. **Never touched reality.** This command's own composition (config, then
   credentials, then a login attempt, then a plug read, then the wrong-box
   guard, wired together exactly this way) has never been exercised
   against a real Wyze account by anyone. **No agent can ever run this
   command for real** — `wyzr` is forbidden to install on the fleet box the
   agent fleet runs on, and this command's own binary is not exempt from
   that rule. The only way it is ever exercised for real is a human
   executor running it on the manager box — see "The capture format"
   below for how that run becomes part of this repo's own record.
2. **Exercised by hand, once, outside this product** (2026-09-10): see
   "`wyzr cycle`"'s own honesty-split section above — establishes the plug
   controls the box and that cutting it does not brick it; nothing about
   this repo's code.
3. **PROVEN through this repo's own code — the READ paths, 2026-09-11.**
   `devices list`/`plug status` ran on the manager box against the real
   account: exit 0, matching an earlier hand measurement mac-for-mac. So
   the primitives this command's own plug-read check stands on (login, the
   auth envelope decode, the device-host body, `get_property_list`'s field
   names, P3/P5 decoding) are exercised end to end. **This command's OWN
   composition of them is new, unexercised wiring — not a new measurement
   of the primitives themselves.**
4. **Still never exercised: the write path.** This command holds no
   `PlugWriter` anywhere in its dependency graph (see "Structurally
   incapable of switching a plug" above) — `plug on`/`plug off` have never
   run through this product, by anyone, ever, and this command cannot
   exercise them even by accident.

## The capture format

See `docs/capture-format.md` for the full spec and a worked, end-to-end
example built from synthetic placeholder data. Summary: `wyzr` cannot run
for real anywhere an agent can reach, so a named, willing human executor on
the manager box is the only channel through which reality reaches this
repo — and the format in which they record what they saw (the exact
command, the exact output, timestamps, the verdict, and **what was expected
BEFORE the run**, in that structural order) is a real engineering artifact,
implemented in `src/capture-format.ts`.

**The address-disclosure boundary this format owns:**
`src/cycle-wrong-box.ts`'s wrong-box guard interpolates every resolved
target/local address into its own evidence trail, and that reaches `wyzr
doctor --json`/`wyzr cycle --dry-run --json` alike — the epic ruled that
disclosure load-bearing and acceptable **where it is READ** (an operator's
own screen; scrubbing it there would make a mistaken refusal
undiagnosable). Pasting that same `--json` output into a ticket is the
TRANSMISSION half of that same boundary, and this format owns it:
`src/capture-format.ts`'s `redactAddressesForPasteBack()` replaces every
IPv4/IPv6/IPv4-mapped-IPv6 literal with `<address-redacted>` on the
paste-back path only — never touching the diagnostics an operator reads on
their own screen, since this module is never imported by `src/output.ts` or
any command's own rendering. Required test
(`test/unit/capture-format.test.ts`): built from
`src/cycle-wrong-box.ts`'s own `evaluateWrongBoxGuard()`, with placeholder
addresses in each shape `canonicaliseAddress()` recognizes — never a
hand-typed string shaped to make the test pass.

## Development

```sh
bun install
bun run typecheck
bun run lint
bun run test            # test/unit, no credentials needed
bun run test:coverage   # same, with the coverage floor from bunfig.toml enforced
bun run check:no-console
```

If you add an integration-test directory later, keep it a separate
directory and a separate CI job from `test/unit`, and make sure it skips
cleanly (does not fail) with no credentials configured.
