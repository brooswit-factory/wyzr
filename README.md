# wyzr

A TypeScript library, plus a CLI over it, for Wyze devices: list devices,
read a smart plug's status, and turn a plug on and off.

wyzr exists so the plug that powers an agent-workforce host can be power
cycled from a client that depends on nothing running on that host itself —
see the story ticket for the full motivation.

**Status: foundation scaffold only.** This repo currently ships the project
skeleton, the redaction-proof output core, the typed exit-code layer, and
gating CI — no Wyze API, auth, transport, or device commands exist yet.
Those land in later stories. See "Live-device coverage" below.

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

## Credentials (not yet implemented)

wyzr will read a Wyze account email plus an API key id and secret from a
file — the exact shape is a later story's decision, not this one's. This
repo never contains real credentials, and nothing shaped like one: tests
use obviously-fake tokens, and CI has none configured. The entire suite
runs and passes with **no credentials of any kind** present.

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
