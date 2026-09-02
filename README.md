# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation + credentials loading.** This repo ships the project
skeleton, the redaction-proof output core, the typed exit-code layer,
gating CI, and file-backed credentials loading (`src/credentials.ts`) —
still no Wyze API, auth, transport, or device commands. Those land in
later stories. See "Live-device coverage" below.

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
| `totpSecret` | no       | TOTP secret, only if the account has MFA enabled. Absent (or `null`) when the account has none. |

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

## Live-device coverage

**Nothing in this repo has ever been exercised against a real Wyze
device.** There is no Wyze API client, no auth, and no transport here yet
— this story is the foundation only. A green CI badge on this repo
reflects the scaffold (typecheck/lint/test/coverage/no-direct-console),
not hardware coverage. Later stories that add real device interaction are
expected to update this section — a green badge must never be read as
implying hardware has been touched until it says so here explicitly.

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
