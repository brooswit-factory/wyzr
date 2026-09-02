# Changelog

All notable changes to this project are documented in this file.

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
