# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- `src/credentials.ts`: file-backed credentials loading from
  `$XDG_CONFIG_HOME/wyzr/credentials.json` (or `$HOME/.config/wyzr/` when
  unset) — the only way a Wyze secret enters this process. Validates the
  `email`/`password`/`keyId`/`keySecret` (required) and `totpSecret`
  (optional) field set, refuses a group- or world-readable file or
  directory outright, rejects unknown fields, and registers every secret
  with `src/redact.ts` before returning. No credential flag on the CLI, no
  environment-variable secret fallback. See README's "Credentials" section.
- `src/transport.ts`: the injectable `WyzeTransport` interface everything
  that talks to Wyze goes through, plus a real implementation
  (`src/transport-http.ts`, HTTP-performing function injectable for
  network-free testing) and a fake implementation
  (`src/transport-fake.ts`, synthetic canned responses, never a capture of
  real traffic).
- `src/auth-session.ts`: `WyzeAuthSession` — logs in with the triple-MD5
  password hash (`src/wyze-auth-hash.ts`) and wyzr's own minted
  app-identity key (`src/app-identity.ts`), detects and answers a TOTP MFA
  challenge (`src/totp.ts`, RFC 4226/6238 against `node:crypto`, verified
  against RFC 6238's own test vectors) or produces a clear actionable
  error for SMS/missing-secret/unrecognized challenges, holds tokens in
  memory, and refreshes-and-retries exactly once on an expired access
  token (bounded against infinite recursion). `getObjectList()` exists on
  the interface for the next story's `wyzr devices list` to consume.
- `src/wyze-envelope.ts`: defensive, string-vs-number-safe interpretation
  of Wyze's `{code, msg, data}` response envelope.
- `src/wyze-errors.ts`: typed, actionable errors for the auth/session flow
  — notably the errorCode-1000 message naming both a wrong-credentials and
  an SSO-only-account possibility.
- `src/errors.ts`: new `ExitCode.MfaRequired` (7) for an MFA challenge that
  could not be answered automatically.
- Access and refresh tokens are registered with `src/redact.ts` the moment
  they are received — in `src/transport-http.ts` as soon as a real HTTP
  response is parsed, and in `src/auth-session.ts` as soon as tokens are
  extracted from any successful envelope (login, MFA, or refresh) — before
  any caller could print one.

### Changed

- `.gitignore`: widened `credentials.json` to `*credentials*.json` — keeps
  every `.ts` source file visible while also catching
  `wyze-credentials.json`, `credentials-prod.json`, `credentials.json.bak`,
  etc. Carried forward from WYZR-10's review.
- `src/credentials.ts`: an empty-string `totpSecret` is now treated
  identically to absent/`null`, fixed at the source so the exported type's
  optionality means what it says. Carried forward from WYZR-10's review.

**Nothing added in this story has ever been exercised against a real Wyze
account or device** — see README's "Live-device coverage" section.

## [0.1.0] - 2026-09-02

### Added

- Bun + TypeScript project skeleton: strict `tsconfig.json`, `bun.lock`,
  `.gitignore`, and `typecheck`/`lint`/`test`/`test:coverage` scripts.
- `src/output.ts`: the single module every terminal write in `src/` routes
  through (human and `--json`, stdout and stderr), scrubbing every string
  with `src/redact.ts` before printing.
- `src/redact.ts`: a secret registry plus generic credential-shape scrubbing
  (`Authorization: Bearer`, `Authorization:`, `X-API-Key:`, `Apikey:`,
  `Keyid:`, JSON `access_token`/`refresh_token`), with a no-op guard for
  empty/undefined/null registrations.
- `src/errors.ts`: `ExitCode`/`ExitCodeName` and `CliError`, mapped to a
  process exit code at the single boundary in `src/cli.ts`.
- `scripts/check-no-console.ts`: CI gate that fails on any direct
  `console.*`/`process.std*.write`/`Bun.write(std stream)` call under
  `src/` outside `src/output.ts`.
- GitHub Actions CI: `typecheck`, `lint`, `test` (with a coverage floor),
  and `no-direct-console` jobs, gating both `pull_request` and `push` to
  `main`.

No Wyze API, auth, transport, or device command code — that is later
stories' scope. Nothing in this scaffold has been exercised against real
Wyze hardware.
