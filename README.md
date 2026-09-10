# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation + credentials + transport/auth + `devices list` +
`plug status`/`plug on`/`plug off` + the wedge-proof engine and `wyzr wedge
status`.** This repo ships the project skeleton, the redaction-proof output
core, the typed exit-code layer, gating CI, file-backed credentials loading
(`src/credentials.ts`), an injectable Wyze transport boundary with a real
HTTP implementation, a fake implementation, the auth session that logs in,
handles MFA, and holds/refreshes tokens, `wyzr devices list`, the three verbs
the whole product exists to provide (`wyzr plug status|on|off`), and now the
gate that decides whether the destructive power-cycle verb (a later story)
is ever allowed to run, plus the read-only command that shows its reasoning.
See "Wyze transport and auth session", "`wyzr devices list`", "`wyzr plug
status|on|off`", "Live-device coverage", and "`wyzr wedge status`" below.

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

Codes 8/9/10 were added by `wyzr plug status|on|off` (WYZR-13); 11/12 were
added by `wyzr wedge status` (WYZR-17) — both appending only, never
renumbering or reusing an existing code. 0–7 are unchanged from earlier
stories.

### Two classes of non-zero exit code

**Codes `2`/`3`/`4`/`5`/`6`/`8` are ERROR codes.** Something kept the
command from doing its job at all. These are thrown as a `CliError`,
handled by `src/cli.ts`'s single error boundary, and printed under
`--json` as the `{"error": {...}}` envelope below, on stderr.

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
non-empty, else `$HOME/.config/wyzr/credentials.json`.

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
projection), `src/wedge-config.ts`'s env-var loader (explicitly
provisional — see "Configuration" below), and every unexported helper in
`src/wedge-runner.ts` (`attempt()`, the `toXObservation()` functions).

### Configuration

**No fleet hostname, tunnel name, or credential is hardcoded anywhere in
this repo.** This repo is public; epic WYZR-1 deliberately kept fleet
hostnames out of it, which this task keeps doing. Every host-specific
value is injectable; **WYZR-20 (a later, already-filed story) owns the
real config file and install** — the loader below is this task's own
honest, provisional stand-in, not that story's design being settled.

`src/wedge-config.ts`'s `loadWedgeConfigFromEnv()` reads:

| Env var | Configures |
| --- | --- |
| `WYZR_WEDGE_JIRA_BASE_URL` + `WYZR_WEDGE_JIRA_AUTH_HEADER` (both required together) | Jira-activity. `WYZR_WEDGE_JIRA_PROJECT_KEY` narrows the query; `WYZR_WEDGE_JIRA_QUIET_THRESHOLD_MS`/`WYZR_WEDGE_JIRA_TIMEOUT_MS` override the defaults. |
| `WYZR_WEDGE_GITHUB_OWNER` | GitHub-activity. `WYZR_WEDGE_GITHUB_REPO` scopes to one repo (org-wide otherwise); `WYZR_WEDGE_GITHUB_TOKEN` is optional (unauthenticated works for public targets, at a lower rate limit — see below). |
| `WYZR_WEDGE_SSH_HOST` | The ssh direct path. |
| `WYZR_WEDGE_TUNNEL_PING_HOST` | The tunnel-ping direct path. |
| `WYZR_WEDGE_LOCAL_CONNECTIVITY_TARGET` | Overrides the local-connectivity control's default target (`1.1.1.1`) — the one field that already has a safe default. |
| `WYZR_WEDGE_CONTROL_PLANE_NAME` | Presence alone opts the control-plane reading in (its value is only ever used as a label). |

Every field above defaults to **unconfigured** when its env var is
absent — never a guess. **This is the NORMAL state until WYZR-20 ships,**
which is exactly why "unconfigured never counts toward a quorum" (see
"The instruments" above) is load-bearing rather than tidy: it is the
state this code will actually be in the first time anyone runs it.

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
