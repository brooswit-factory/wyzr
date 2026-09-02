# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation + credentials + transport/auth.** This repo ships the
project skeleton, the redaction-proof output core, the typed exit-code
layer, gating CI, file-backed credentials loading (`src/credentials.ts`),
and now an injectable Wyze transport boundary with a real HTTP
implementation, a fake implementation, and the auth session that logs in,
handles MFA, and holds/refreshes tokens — still no CLI commands. Those land
in a later story. See "Wyze transport and auth session" and "Live-device
coverage" below.

## Install / usage

```sh
bun install
bun link   # or: bunx --bun github:brooswit-factory/wyzr#<ref> --help
wyzr --help
```

```
wyzr — a CLI for Wyze devices

Usage: wyzr [--json] <command> [args]
```

No commands are registered yet (foundation story) — every command name
currently exits with the `Usage` error below. `--json` switches both
success and error output to machine-readable JSON on stdout/stderr.

## Exit codes

Defined in `src/errors.ts` (`ExitCode`). `CliError` carries one of these;
`src/cli.ts` is the single boundary that maps a thrown error (a `CliError`
or otherwise) to the process's exit code. New codes may be added by later
stories — the numbers already assigned here never change or get reused.

| Code | Name                 | Meaning                                          |
| ---- | -------------------- | ------------------------------------------------- |
| 0    | `ok`                 | Success.                                           |
| 1    | `generic`             | Unexpected/uncategorized error.                    |
| 2    | `usage`               | Bad flags/arguments, or an unknown command.        |
| 3    | `credentials_invalid` | Credentials missing or invalid.                    |
| 4    | `not_found`           | Requested device/resource does not exist.          |
| 5    | `network`             | Transport/network failure — no response at all.    |
| 6    | `api_error`           | The API responded, but with an error.              |
| 7    | `mfa_required`        | An MFA challenge could not be answered automatically. |

## Errors under `--json`

On any error, `--json` mode prints exactly one JSON value to **stderr**
(never stdout) instead of a prose message:

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
response is ever printed wholesale on any path; this story adds no
`printHuman`/`printJson` call at all (no CLI command lands until the next
story), so there is no print path
to audit yet beyond what `src/output.ts` already covers.

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

## Live-device coverage

**Nothing in this repo has ever been exercised against a real Wyze account
or device.** `src/transport-http.ts` has never made a real HTTP call to
`auth-prod.api.wyze.com` or `api.wyzecam.com`; `src/app-identity.ts`'s
minted key has never been sent to Wyze; `src/totp.ts`'s math is proven
against RFC 6238's own vectors but has never answered a real challenge;
the MFA-detection field names and the `submitMfa`/`getObjectList` request
shapes are this author's inference, not a confirmed contract; the token
lifetimes and refresh behavior are only as documented in the
finding, at reduced confidence, never observed directly. Every path in
this repo is exercisable end to end against `FakeWyzeTransport` with no
credential present at all — that is the design, not a limitation — but a
green suite here proves this code matches this repo's own belief about the
Wyze API, and **cannot** tell you that belief is wrong. A green CI badge
reflects the scaffold and this story's logic (typecheck/lint/test/coverage
/no-direct-console), not hardware or live-API coverage. Later stories that
add real device interaction are expected to update this section — a green
badge must never be read as implying hardware or a real account has been
touched until it says so here explicitly.

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
