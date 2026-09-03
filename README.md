# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation + credentials + transport/auth + `devices list` +
`plug status`/`plug on`/`plug off`.** This repo ships the project skeleton,
the redaction-proof output core, the typed exit-code layer, gating CI,
file-backed credentials loading (`src/credentials.ts`), an injectable Wyze
transport boundary with a real HTTP implementation, a fake implementation,
the auth session that logs in, handles MFA, and holds/refreshes tokens,
`wyzr devices list`, and now the three verbs the whole product exists to
provide: `wyzr plug status|on|off`. See "Wyze transport and auth session",
"`wyzr devices list`", "`wyzr plug status|on|off`", and "Live-device
coverage" below.

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

Codes 8/9/10 were added by `wyzr plug status|on|off` (WYZR-13), appending
only — 0–7 are unchanged from earlier stories.

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

### The fake's responses are SYNTHETIC, not a capture

`docs/wyze-api-findings-2026-09-02.md`'s explicit unknown #1 is that no
captured example of a real Wyze response payload exists in any (a)/(b)-tier
source found during that research. Every canned envelope in
`src/transport-fake.ts` is therefore **constructed from the finding's
description of the envelope shape**, never observed — each export is
labeled `SYNTHETIC` in its own doc comment. A green test against this fake
proves this repo's code matches this repo's own belief about the Wyze API.
**It is not, and must never be read as, evidence about the real API.**

### Auth flow

`login()` sends, per the finding's §Q3 (tier (b), read from the
actively-maintained `wyze-sdk`'s own source):

- `email` — plain, from `credentials.json`.
- `password` — **never raw**. Sent as `md5(md5(md5(password)))`
  (`src/wyze-auth-hash.ts`'s `wyzeTripleMd5`), MD5 applied three times in a
  chain. Get this wrong and login fails with the same errorCode 1000 as a
  wrong password (see below) — there is no way to tell the two apart from
  the response alone.
- `nonce` — a fresh value per login attempt. The finding documents that a
  nonce is sent but not its required format; the default here
  (`String(Date.now())`) is this project's own reasonable choice, not a
  confirmed Wyze requirement, and is injectable (`AuthSessionDeps.nonce`)
  for tests and for a future correction.
- `keyid` / `apikey` — the user's own Developer API Key ID/Secret, from
  `credentials.json` (`keyId`/`keySecret`).

Every call additionally carries an `x-api-key` header — see "The
app-identity key" below.

### The app-identity key

The finding (§Q3) is explicit that a **second, separate, non-user-specific
key** is sent as `x-api-key`, hardcoded into the community SDK's own
source to identify the calling app/library, distinct from the user's own
key pair above. The finding deliberately declined to reproduce that
embedded value, and the ticket forbade copying it out of another project's
source.

`src/app-identity.ts` mints wyzr's own: `APP_IDENTITY_KEY` is the SHA-256
hex digest of a fixed, versioned, wholly-public seed string,
`"wyzr-app-identity-key-v1"`, naming this project — not derived from,
resembling, or related to any other project's key. **Whether Wyze's API
accepts a value it never issued is UNVERIFIED** — the finding is explicit
(tier (d)) that it could not check this without an authenticated call,
which is out of scope for this project. Treat "our key is accepted" as an
untested hope, not a working assumption.

### MFA handling — and its limits

The finding establishes (tier (b)) that login can return a TOTP or SMS
challenge. `src/auth-session.ts` detects a challenge from the response
`data`'s shape (`mfa_options` + a verification id — see
`src/wyze-envelope.ts`'s `detectMfaChallenge()`), checked **before** any
`code`-based success/failure interpretation, because the finding does not
establish what `code` value accompanies a challenge.

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
reads (`mfa_options`, `verification_id`, `sms_session_id`) and the
MFA-answer endpoint/body shape (`submitMfa` re-POSTs to the login endpoint
— see `src/transport-http.ts`) are this author's own inference (tier (d)),
modeled on common reverse-engineered mobile-app auth patterns, not
confirmed against any captured real payload. The TOTP **math** is proven
correct against a published standard; the **plumbing** that detects and
answers a real Wyze challenge has never run against one.

### The response envelope, and the string-vs-number ambiguity

Every call's response is `{"code": ..., "msg": ..., "data": {...}}`
(`src/wyze-envelope.ts`). The finding is explicit that success (`code ==
"1"`) is a **string**, not the number `1` — a strict `=== 1` check would be
silently wrong. It gives `1000` (invalid credentials) and `2001`
(access-token-expired) "without pinning their wire type as carefully."

This repo's answer: `normalizeCode()`/`normalizeMsg()` coerce `code`/`msg`
to a string with `String(...)` **once**, and every comparison
(`isSuccessEnvelope`, `isInvalidCredentialsCode`, `isAccessTokenExpired`)
goes through that normalized form — so a wire value of the number `1000`
and the string `"1000"` are handled identically, and likewise for `1`,
`2001`, and any other code the finding didn't pin down. This was verified
red-first: see the PR body for the exact failing output observed when
`isSuccessEnvelope` was temporarily changed to compare against the number
`1` instead.

### The errorCode 1000 trap

A Wyze account created via Google/Apple SSO has no Wyze-native password,
so the triple-MD5 chain has nothing to hash, and login fails with
**errorCode 1000 — the same code as a genuinely wrong password**
(finding §Q3/§Q7). `src/wyze-errors.ts`'s
`wyzeInvalidCredentialsOrSsoOnlyError()` names **both** possibilities and
points at the fix: open the Wyze app → Account → Security and look for
"Change Password" — if it is not there, the account is SSO-only and needs
a Wyze-specific password set before wyzr can log in.

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

Per the finding's §Q4, `P3` (power) and `P5` (reachability) are both wire-
encoded as an **integer**, `0` or `1` — never a native JSON boolean.
`src/plug.ts`'s `decodeP3()`/`decodeP5()` accept **exactly** the number
`1`/`0` and the string `"1"`/`"0"` (the string form defensive, mirroring
`src/devices.ts`'s `classifyState()` precedent). **Everything else,
including a native JSON `true`/`false`, decodes to `"unknown"`
(`P3`)/`null` (`P5`) — REJECTED, never helpfully coerced.** A boolean is
precisely the silently-wrong wire assumption the finding warns about;
degrading loudly to "unknown" on a wrong guess about the wire type is safer
than a confident misread. `test/unit/plug.test.ts` ships a dedicated
boolean-rejection test for each, run red-first (see the PR body for the
actual red output observed when `decodeP3`/`decodeP5` were temporarily
changed to coerce `true`/`false`).

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
`fakePropertyListEnvelope(props)` and `fakeSetPropertyEnvelope()` are new,
equally synthetic, siblings for `get_property_list`/`set_property`. Every
one of these remains SYNTHETIC — constructed from the finding's
description of the shape, never a capture of real Wyze traffic.

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

**Nothing in this repo has ever been exercised against a real Wyze account
or device.** `src/transport-http.ts` has never made a real HTTP call to
`auth-prod.api.wyze.com` or `api.wyzecam.com`; `src/app-identity.ts`'s
minted key has never been sent to Wyze; `src/totp.ts`'s math is proven
against RFC 6238's own vectors but has never answered a real challenge;
the MFA-detection field names and the `submitMfa`/`getObjectList` request
shapes are this author's inference, not a confirmed contract; the token
lifetimes and refresh behavior are only as documented in the
finding, at reduced confidence, never observed directly.

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
