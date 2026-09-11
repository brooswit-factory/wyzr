# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- The single, file-backed configuration surface (WYZR-20/WYZR-28):
  `src/config.ts`'s `loadWyzrConfig()` replaces the three provisional
  env-var loaders (`loadWedgeConfigFromEnv`/`loadRecoveryConfigFromEnv`/
  `loadCycleConfigFromEnv`, all removed) with ONE validated JSON file at
  `<XDG_CONFIG_HOME or $HOME/.config>/wyzr/config.json`, resolved by the
  same rule `src/credentials.ts` uses for `credentials.json`. The CLI now
  reads nothing from the environment for configuration — a dedicated test
  pins that no `WYZR_*` env var can influence the loaded config.
  - Mirrors `src/credentials.ts`'s own discipline: refuses an
    over-permissive directory or file, an unknown top-level field, a
    missing/mistyped required value, and a present-but-incomplete
    optional section — never a silent default, never a partial load,
    never an error message that echoes a config value. ONE new exit code
    (`ExitCode.ConfigInvalid`, 26), distinguished by `reason`, mirroring
    `credentials_invalid`'s own precedent.
  - `suspectBox.host` is now the single REQUIRED value feeding the ssh
    direct path, the wrong-box guard's target, and the reused
    uptime/daemon/fleet-audit host — deliberately one field, not several
    that could silently disagree about which box is wedged and which box
    a power cycle would cut.
  - The fleet plug and the safe plug (`fleetPlug`/`safePlug`, both
    required) are branded as `FleetPlugTarget`/`SafePlugTarget`, two
    structurally unrelated types (a module-private `unique symbol` brand
    each, same technique as `PreconditionsClearedWitness`) so a
    safe-plug-only operation can never type-check against the fleet
    plug — pinned with a mutation-tested `@ts-expect-error` test. A
    config where both plugs resolve to the same device is refused at
    load time. The schema can express a sub-device target
    (`subDeviceId`), for an `OutdoorPlug` (`WLPPO`)'s `-SUB` children.
  - `docs/config.example.json`: a complete, placeholder-only, genuinely
    loadable example of every required key and optional section (a test
    loads it directly). `.gitignore` makes an accidental `/config.json`
    in the repo root impossible to commit.
  - `src/cycle-wrong-box.ts`'s `evaluateWrongBoxGuard()`: closed the
    empty-resolved-address-set hole — an empty (but non-null) array used
    to fall through to `not_target` (clearing vacuously on a verb that
    cuts mains power); it now refuses (`inconclusive`), same as a `null`
    result. Watched failing first; the structural pin that
    `RealWrongBoxIdentityProbe` still converts an empty resolver result
    to `null` was already in place from WYZR-27.

- `wyzr doctor` (WYZR-20/WYZR-29) — a read-only preflight command answering
  "is this install actually able to pull the lever?", plus the CAPTURE
  FORMAT an executor uses to record a real run and paste it back into a
  ticket. **Must itself read a plug, so `test/unit/recovery-imports.test.ts`'s
  own "no import path to the transport/auth layer at all" property does not
  apply here** — see `test/unit/doctor-imports.test.ts` (import-closure,
  watched RED first),`test/unit/doctor-plug.test.ts` (a mutation-tested
  `@ts-expect-error` pin proving a write call inside a function typed to
  accept only `PlugReader` does not typecheck), and
  `test/unit/doctor-no-write.test.ts` (a source-level grep over a file set
  DERIVED from the same import-closure walk `doctor-imports.test.ts`
  performs, minus a 2-entry allowlist of legitimate `writePower`/
  `setProperty` definers — fails CLOSED, so a new doctor-adjacent module is
  automatically scanned the moment it becomes reachable, unlike this
  check's own first version, which review caught scanning a HARDCODED
  four-file array that a fifth, newly-added module reaching `writePower()`
  passed straight through) — three checks, each blind to a different
  failure shape.
  - Reports config/credentials presence+permission (never a configured
    value), a login attempt's success/failure (relayed VERBATIM, never
    diagnosed — an auth failure's cause is genuinely ambiguous, see
    `errorCode 1000`), each configured plug's `resolvable`/`readable`
    state independently, the outside instruments' configured/reachable
    state, and the wrong-box guard's own verdict (reused from
    `src/cycle-wrong-box.ts`, never re-implemented) verbatim, including its
    full evidence trail.
  - Uses this repo's existing four-way `CheckOutcome` vocabulary
    (`src/recovery.ts`, reused rather than re-invented) and the same
    could-not-look-outranks-not-configured-outranks-ready precedence
    `evaluateRecovery()` established, extended with its own propagation
    rule for checks that genuinely NEST (no credentials -> no login
    attempt -> no plug read): a check blocked by an unconfigured
    prerequisite reports itself `not-configured` too; a check blocked by a
    BROKEN prerequisite reports `could-not-look` — see `src/doctor.ts`'s
    `blockedByPrerequisite()`.
  - New exit codes `27`/`28`/`29` (`doctor_not_ready`/`doctor_inconclusive`/
    `doctor_unconfigured`), append-only from `26`. READY reuses `0`.
  - `src/capture-format.ts`: `redactAddressesForPasteBack()` scrubs every
    IPv4/IPv6/IPv4-mapped-IPv6 literal (the exact shapes
    `src/cycle-wrong-box.ts`'s `canonicaliseAddress()` recognizes) from the
    paste-back path only — never the diagnostics an operator reads on
    their own screen, which the epic ruled load-bearing there. A
    `CaptureRecord` template puts the falsification criterion structurally
    BEFORE the result, and `toProvenanceFixtureComment()` converts one into
    a `PROVENANCE: CAPTURED-LIVE, <date>` tag matching
    `src/transport-fake.ts`'s own convention — see `docs/capture-format.md`
    for the full spec and a worked, synthetic-data example end to end.

- `wyzr rehearse-safe-plug-write` (WYZR-20/WYZR-30) — the staged rehearsal
  of this product's FIRST real plug write. `plug on`/`plug off`, and
  therefore `wyzr cycle` itself, have never run through this product's
  code, by anyone, ever; this command is what will move the write path
  from "never exercised" to "exercised, once, on a date a human executor
  records" — **when a human runs it, not when this merged.** See
  `docs/write-rehearsal-procedure.md` for the executor procedure, and
  README's own section for the design.
  - **Safe-plug-only, two independent guards.** Typed to accept ONLY
    `SafePlugTarget` (WYZR-28's branded config types) — a `FleetPlugTarget`
    is a compile error, mutation-tested with a `@ts-expect-error` pin —
    PLUS an independent runtime check (`src/config.ts`'s own
    `samePlugIdentity()`, reused, now exported) that refuses BEFORE any
    read or write if the two plugs resolve to the same device. Provably
    unreachable through the real CLI today (`loadWyzrConfig()` already
    refuses a conflated config at load time) and kept anyway, on the exact
    precedent `src/cli-cycle.ts`'s `resolveForced()` sets for its own
    defensive "unreachable in practice" branch. No CLI positional argument
    names the target, ever — an extra/unrecognized argument is a Usage
    error, not a silently-accepted device query.
  - **No path ends with the plug off.** Reuses `src/cycle-runner.ts`'s own
    exported `performOff()`/`performRestoreNeverGiveUp()`/`describeOff()`/
    `describeRestore()` UNCHANGED (newly exported for this purpose) — one
    at-most-once-OFF/never-give-up-ON implementation in this codebase, not
    two that could diverge. Every constructed failure case (the OFF write
    throws, the OFF read-back throws, the OFF read-back says "unknown",
    the restore itself throws on every attempt) still attempts the restore
    and reports the outcome; an unconfirmed restore is `stranded`,
    reported as loudly as `wyzr cycle`'s own `CycleStranded` — instructing
    the executor to restore the SAFE plug by hand, since (unlike the fleet
    plug) there is no configured remote restore command for it.
  - **A human-chosen-moment confirmation ceremony**, same D4 precedent as
    `wyzr cycle`'s own force ceremony: a long explicit flag
    (`--confirm-write-i-have-chosen-this-moment`), the full unwritten
    preview printed before anything is acted on, and an interactive-or-
    non-interactive confirmation naming the safe plug's exact configured
    name. With NO flags at all — or with `--dry-run` — this command runs
    the same preview and never writes; the confirm flag alone is never
    sufficient.
  - `wyzr doctor` remains structurally incapable of reaching this write
    path — `test/unit/doctor-imports.test.ts`'s import-closure walk now
    also forbids `src/rehearsal-runner.ts`/`src/cli-rehearsal.ts`,
    extended and watched failing first (a temporary import wired from
    `src/cli-doctor.ts`, captured failing, then reverted).
    `test/unit/doctor-no-write.test.ts` needed no change: its own scanned
    set derives from the same closure, so it excludes this command's files
    automatically as long as they stay unreachable.
  - New exit codes `30`-`33`
    (`rehearsal_refused_same_as_fleet_plug`/`rehearsal_refused_by_precondition`/
    `rehearsal_preview_would_write`/`rehearsal_stranded`), append-only from
    `29`. `confirmed` reuses `0`.
  - No new config surface: reuses `config.fleetPlug`/`config.safePlug`
    (required, WYZR-28) and `config.cycle.timing` (WYZR-19/WYZR-27)
    unchanged.
  - `src/rehearsal-paste-back.ts` (review finding 2): the generic
    `redactAddressesForPasteBack()` alone was measured to miss the safe
    plug's own configured NAME in every case and its MAC in every
    spelling but one (a colon-form mac only survived by accident, matching
    the IPv6-candidate pattern). `renderRehearsalForPasteBack()` elides
    this run's own `mac`/`name`/`subDeviceId` by VALUE, regardless of
    spelling, composed with the address redaction — the one function
    `docs/write-rehearsal-procedure.md` now points the executor at.
  - `docs/write-rehearsal-procedure.md` (review finding 1): a new,
    first-in-section step requires the executor to confirm the safe plug
    does not power the machine running the command before proceeding — if
    it does, the OFF would cut power to the process itself, and the
    never-give-up restore (which needs the process alive to retry) never
    runs. No code can detect this; "no path ends with the plug off" is now
    stated everywhere as holding for every failure the running process
    SURVIVES, not for the process being killed mid-run.

- The post-cycle recovery engine and `wyzr recovery status` (WYZR-18/WYZR-25)
  — a read-only command answering "did that power cycle actually work?" with
  evidence, not assumption. **Ships no plug-switching capability at all, and
  reads no plug-liveness signal whatsoever** — no import path exists from any
  file here to a write verb, proved by `test/unit/recovery-imports.test.ts`
  walking the transitive import closure (watched RED first).
  - `src/recovery.ts`: the pure, injectable-boundary engine —
    `evaluateRecovery()` takes `--since` (the power-off instant) plus
    already-gathered observations and produces a `RecoveryVerdict`
    (`RECOVERED`/`NOT_RECOVERED`/`FLEET_HALF_RESTORED`/`INCONCLUSIVE`/
    `UNCONFIGURED`) plus its full evidence trail. Five checks, each reporting
    independently: reachability (ssh/tunnel-ping, reused from WYZR-16),
    reboot (a skew-safe DURATION comparison — the box's own uptime, read from
    its monotonic clock, against elapsed time since `--since`, never a
    cross-machine wall-clock instant comparison), daemon health (unit AND
    scope both required, four distinguishable outcomes including
    "pointed-at-nothing" for a wrong scope), outside-instrument resumption
    (Jira/GitHub activity reused from WYZR-16, counting only activity AFTER
    the cut), and a fleet-pane audit for the herdr bare-`claude --resume`
    restore trap (detects and reports only — the fix is WYZR-21). A
    `PlugLivenessReading` type mirrors `ControlPlaneReading`'s
    `@ts-expect-error`-pinned structural exclusion, verified the same way
    (directives removed, `TS2739` observed, restored).
  - `src/recovery-probes.ts`/`recovery-probes-real.ts`/`recovery-probes-fake.ts`:
    the three genuinely new probes (uptime via `/proc/uptime`, daemon via
    `systemctl show`, fleet audit via `ps`), composed alongside
    `WedgeProbes` (reused verbatim, never widened — it is a published
    interface WYZR-19 depends on) rather than extending it. The fleet-audit
    classifier returns COUNTS ONLY — no raw argv, pid, or session id can
    reach any output field on any path, including every error path.
  - `src/recovery-runner.ts`/`recovery-config.ts`: real wall-clock and every
    probe call live here, never in the pure engine; config reuses WYZR-16's
    `WYZR_WEDGE_*` env vars for the shared probes, and the three new probes
    reuse the same ssh host rather than introducing a second one.
  - `src/cli-recovery.ts`: `wyzr recovery status --since <ISO-8601
    timestamp>`, human and `--json`, allowlist-projected.
  - `src/errors.ts`: exit codes 13/14/15/16 appended (RECOVERED reuses `0`).

- The wedge-proof engine and `wyzr wedge status` (WYZR-17) — decides
  whether the destructive power-cycle verb (a later story, `wyzr cycle`)
  is ever allowed to run, plus a read-only command that shows the
  engine's full reasoning. **Ships no plug-switching capability at all —
  no import path exists from any file here to a write verb.**
  - `src/wedge.ts`: the pure, injectable-boundary engine —
    `evaluateWedge()` takes already-gathered observations and produces a
    `WedgeVerdict` (`PROVEN`/`NOT_PROVEN`/`INCONCLUSIVE_BY_SHARED_CAUSE`)
    plus its full evidence trail. Independence between two silent
    instruments is a real computation over each one's declared
    `dependsOn` set, never a hardcoded probe count — a shared,
    unconfirmed dependency never satisfies it on its own. The clock
    (`now`) is an injected input; the engine reads no ambient time
    source anywhere. `ControlPlaneReading`/`LocalConnectivityObservation`
    are distinct, `__brand`-tagged types from `InstrumentObservation` —
    structurally inadmissible to the instruments collection the
    quorum/independence computation reads (proved by a
    `@ts-expect-error` line `bun run typecheck` fails without), and the
    engine never branches on a control-plane reading before a verdict is
    already decided, so a green control-plane signal cannot flip a
    verdict in either direction.
  - `src/wedge-probes.ts`/`wedge-probes-real.ts`/`wedge-probes-fake.ts`:
    the injectable probe boundary (Jira-activity, GitHub-activity, ssh,
    tunnel ping, the local-connectivity shared-cause control, and the
    tailscale-style control-plane reading), on the same
    real/fake-pair pattern as `WyzeTransport`. `classifyDirectPath()`
    establishes "dead" by TIMING (this probe's own timeout elapsed, or
    the underlying tool's own connect-timeout was exhausted) rather than
    by parsing stderr text — a fast response of any kind, success or
    failure, is `"unconfirmed"`, never `"dead"`.
  - `src/wedge-runner.ts`: orchestrates a run — every configured probe,
    concurrently, each under its own enforced timeout; every
    instrument/direct-path SLOT always appears in the evidence trail,
    configured or not, so an unconfigured instrument reports itself
    unconfigured rather than silently disappearing.
  - `src/wedge-config.ts`: env-var-backed config loading, defaulting
    every fleet-specific field to unconfigured — no fleet hostname,
    tunnel name, or credential is hardcoded anywhere. Only the
    local-connectivity control's target has a default (`1.1.1.1`,
    Cloudflare's public anycast resolver — no dependency on this
    project's own fleet infrastructure).
  - `src/cli-wedge.ts`: `wyzr wedge status`'s human/`--json` rendering.
    Imports nothing from `cli-plug.ts`/`plug.ts`/`auth-session.ts`/any
    transport module.
  - `src/errors.ts`: appended `ExitCode.WedgeNotProven` (11),
    `ExitCode.WedgeInconclusiveBySharedCause` (12) — OUTCOME codes, not
    error codes, same class as 9/10: the command succeeded at running
    every probe and is reporting what it observed.
  - Jira-activity's request/response shape has never been exercised
    against a real Jira instance (tier (b), from Atlassian's own public
    API docs). GitHub's events API shape, ssh/ping timing behavior
    against an unresolvable vs. a real host, and `tailscale status
    --json`'s `Self.Online` field were all captured live against this
    project's own dev sandbox, 2026-09-10 — see README's "wyzr wedge
    status" section for the exact observations and dates.
- `wyzr plug status <device>`, `wyzr plug on <device>`, `wyzr plug off
  <device>` (WYZR-13) — the three verbs the product exists to provide.
  - `src/plug.ts`: `P3`/`P5` decoding as a closed, boolean-rejecting
    whitelist (`1`/`0`/`"1"`/`"0"` only — a native JSON boolean is
    REJECTED, never coerced), `get_property_list` response parsing,
    read-back outcome classification (`confirmed`/`unconfirmed`/
    `contradicted`), and human-readable formatting that never conflates
    "off" with "state unknown," and never reports a `contradicted` write as
    "failed" (a disagreeing read-back is equally consistent with a write
    that succeeded and simply had not propagated yet).
  - `src/device-resolve.ts`: resolves `<device>` (mac or name, exact,
    case-insensitive, no prefix/fuzzy/substring match) against `devices
    list`'s own projection. Two or more matches — including a
    matches-one-device's-mac-and-a-different-device's-name case — is
    `ambiguous_device`, never a silent choice.
  - `src/cli-plug.ts`: wiring, on the same injectable pattern as `wyzr
    devices list`. Write verbs perform `set_property` then exactly ONE
    immediate `get_property_list` read-back — no sleep, no poll, no retry.
    A read-back that throws is caught and reported as `unconfirmed`, never
    left to surface as a bare transport error.
  - `src/transport.ts`/`transport-http.ts`/`transport-fake.ts`: added
    `getPropertyList`/`setProperty` to `WyzeTransport`, routed through
    `WyzeAuthSession.getPropertyList()`/`setProperty()` (same
    refresh-and-retry-once discipline as `getObjectList()`). The fake
    device-list fixture now takes per-device overrides
    (`FAKE_PLUG_ONLINE`/`FAKE_PLUG_OFFLINE`/`FAKE_PLUG_STATE_UNKNOWN`) so
    this repo's own tests can exercise online/offline/unknown, not just
    the original always-unknown fixture; new synthetic
    `fakePropertyListEnvelope()`/`fakeSetPropertyEnvelope()` fixtures.
  - `src/errors.ts`: appended `ExitCode.AmbiguousDevice` (8),
    `ExitCode.StateUnknown` (9), `ExitCode.WriteContradicted` (10). Codes
    9/10 are OUTCOME codes, not error codes — the command succeeded and is
    reporting what it observed, so it prints its normal `--json` payload
    (with a `verification: { readBacks, waitedMs }` object) and returns the
    code, never throws; codes 0–8 use the existing `{"error": {...}}` path.
  - Never run against real hardware — see README's "Live-device coverage".
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
  any caller could print one. The triple-MD5 password hash is registered
  the same way, the moment it is computed.
- `wyzr devices list` — the first CLI command. Lists the account's devices
  (`src/cli-devices.ts` wires `WyzeAuthSession` + `src/devices.ts`'s
  allowlist projection + `src/output.ts`). Every device is shown; a plug is
  marked (`isPlug`/`[PLUG]`), never filtered, because this project's
  plug-model recognition list is known-incomplete and filtering on it risks
  hiding an operator's real plug. `--json` emits a `schemaVersion`-tagged,
  field-by-field-documented shape (`src/devices.ts`'s `DeviceRecord`).
  Output is built by naming each field to expose (`mac`, `product_model`
  → `model`, `nickname` → `name`, an inferred `conn_state` → `state`),
  never by deleting fields from the raw API object — a dedicated test
  proves an unexpected account-identifier-shaped field never reaches the
  output, run red-first against a spread-based implementation. A malformed
  or missing field on a single device entry never drops that row or
  crashes the command; it becomes a partial row with a `note` that names
  the field and its type, never any part of its value — also run
  red-first. See README's "`wyzr devices list`" section for the full
  contract, the malformed-data strategy, and everything this command
  infers rather than confirms (notably: no captured real
  `get_object_list` response exists anywhere, per
  `docs/wyze-api-findings-2026-09-02.md`'s unknown #1).

### Fixed

- **wyzr could not log in at all, even with correct credentials** (WYZR-15).
  Root cause: this project believed the Wyze auth host and device host
  shared one `{code,msg,data}` response envelope; they do not, and the
  auth host's request shape was also wrong (`keyid`/`apikey` sent in the
  JSON body instead of as headers, plus an unnecessary `x-api-key` header
  and an unrequired `nonce` field — see `src/transport.ts`'s `LoginRequest`
  doc comment). Fixed, all verified against a real, live-measured API
  response wherever one exists (placeholder-credential probe for both
  hosts' error shapes; a relayed real-account measurement — see each
  affected file's own header comment — for the request/success shapes):
  - `src/wyze-auth-envelope.ts` (new): the auth host's own envelope type
    and functions (success — tokens at the top level, not nested under
    `data` — MFA-challenge detection, token extraction, error detection),
    separate from `src/wyze-envelope.ts`'s device-host envelope, which is
    unchanged in its own code path.
  - `src/transport-http.ts`: `login()`/`submitMfa()` send `keyid`/`apikey`
    as headers with a body of only `{email, password}`; every
    `api.wyzecam.com` call now carries the device host's required
    "standard body" (`src/wyze-device-identity.ts`, new — replaces the
    retired `src/app-identity.ts`); `get_property_list`/`set_property` use
    `device_mac`/`device_model`, and `set_property` sends `pvalue` (a
    STRING) instead of `value` (an integer).
  - `src/plug.ts`: decision (A) revised — `P3`/`P5` are wire-encoded as
    strings, not integers; `SetPropertyRequest.value` (`src/transport.ts`)
    is now typed `"0" | "1"`, never a bare number.
  - `src/wyze-errors.ts`: `wyzeInvalidCredentialsOrSsoOnlyError()` rewritten
    to name a third cause behind `errorCode 1000` (a malformed request the
    host never read a key from) alongside the original two (wrong
    credentials; an SSO-only account) — the old wording would have sent an
    operator to change a password that was never the problem.
  - `src/transport-fake.ts`: every fixture standing in for a real response
    is now tagged, in its own doc comment, with its provenance
    (`CAPTURED-LIVE`, `RELAYED`, or `ASSUMED`) — `grep -rn "PROVENANCE:
    ASSUMED" src/` finds every belief in this repo never checked against
    the real API.
  - `docs/wyze-no-credential-probing.md` (new): the repeatable, rate-limit-
    aware manual procedure for observing either host's real error envelope
    with no Wyze account, plus a companion section recording which shapes
    are genuinely credential-gated.
  - `docs/wyze-api-findings-2026-09-02.md` §Q3 corrected in place, dated,
    tiered per-claim in the document's own style.
  - End-to-end through the CLI: a well-formed `credentials.json` with
    obviously-fake placeholder credentials now produces the (rewritten)
    credentials-invalid message and exit `3`, where it previously produced
    `"Wyze API returned an error (code undefined)."` and exit `6`. See the
    PR body for the exact before/after transcript and what that
    comparison does and does not prove (a placeholder-credential run
    cannot, by itself, distinguish "request shape now correct" from "still
    malformed" — both look identical from the outside; only a real-account
    login can tell them apart).
- `src/totp.ts`'s `base32Decode()` no longer echoes the offending
  character into its thrown message when a configured `totpSecret` is not
  valid base32 (e.g. a password pasted into the wrong field by mistake) —
  it now reports only the character's position. The character itself was
  reaching a user-facing error (`wyzeMfaTotpSecretInvalidError`) that
  `src/redact.ts` cannot catch, since the registry matches whole
  registered strings, not one unregistered character of one. Found in
  review; fixed with a dedicated regression test, run red-first.

### Changed

- `.gitignore`: widened `credentials.json` to `*credentials*.json` — keeps
  every `.ts` source file visible while also catching
  `wyze-credentials.json`, `credentials-prod.json`, `credentials.json.bak`,
  etc. Carried forward from WYZR-10's review.
- `src/credentials.ts`: an empty-string `totpSecret` is now treated
  identically to absent/`null`, fixed at the source so the exported type's
  optionality means what it says. Carried forward from WYZR-10's review.

**Nothing added in the WYZR-13 story above has ever been exercised against
a real Wyze account or device** — see README's "Live-device coverage"
section. (WYZR-15, above, is the one exception in this file: its auth-host
and device-host ERROR envelope shapes are this project's own direct,
placeholder-credential observation, and its request/success shapes are a
real-account measurement relayed from elsewhere — see that entry and
README's "Live-device coverage" for exactly what that provenance does and
does not cover.)

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
