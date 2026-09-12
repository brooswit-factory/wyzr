# Wyze API call reconciliation — findings, 2026-09-12

Research-only finding for WYZR-38. No Wyze credentials were obtained, no live
calls were made, and no plug was toggled. This is a source comparison at the
`wyzr` branch point `d3dd379eb04610b95a0bf39ef48e3372197fc570`. [wyzr source,
2026-09-12, tier (b)]

## Sources and confidence

- **(a)** officially documented or directly observed by this project;
- **RELAYED-measured** a real-account observation relayed to this repository,
  strong but vulnerable to transcription error;
- **(b)** actively maintained community code read at a pinned revision;
- **(c)** one person's issue/forum assertion; and
- **(d)** the author's inference.

The community reference remains
[`shauntarves/wyze-sdk`](https://github.com/shauntarves/wyze-sdk), read
2026-09-12 at exact commit
`2d73bfd1c714fb165b9b091b6b493f93fd1245dd`. GitHub reported it unarchived,
with `master` as its default branch and a latest push timestamp of
2026-09-04; its plug client still implements discovery, property reads and
writes. No more complete plug client was identified in the evidence reviewed,
so it remains the right comparison reference. The commit is unchanged from
the 2026-09-02 finding; “today” therefore means a fresh read of the same
source, not new SDK code. [GitHub repository metadata and pinned SDK source,
2026-09-12, tier (b); completeness judgment, 2026-09-12, tier (d)]

The historical column is
`docs/wyze-api-findings-2026-09-02.md`, including its in-place 2026-09-10
correction. Live-measured corrections outrank the SDK source throughout this
document. [repository finding, read 2026-09-12; precedence policy supplied by
WYZR-38]

## Enumeration method and complete call inventory

I searched every file under `src/` for `fetch`, URL/host/path constants, and
all transport method names; read the complete `WyzeTransport` interface;
followed each of its six methods through `RealWyzeTransport.request()`; and
searched again for other `fetch` call sites. All Wyze traffic converges on
that one injected fetch boundary. The unrelated GitHub probe in
`wedge-probes-real.ts` is not a Wyze call. This found exactly six logical Wyze
calls, all HTTP `POST`: login, MFA answer, refresh, object list, property
list, and property write. No second Wyze network boundary or third Wyze host
was found. [wyzr source at branch point, searched 2026-09-12, tier (b)]

For all six calls, wyzr explicitly sends only `content-type:
application/json`; auth calls additionally send the noted credential headers.
It does not explicitly send `Accept-Encoding`, `User-Agent`, `Connection`,
`Authorization`, or an app-key header. The runtime may add ordinary transport
headers, but wyzr neither specifies nor reads them. [wyzr
`transport-http.ts`, read 2026-09-12, tier (b); runtime-header caveat, tier
(d)]

## Three-column diff

Every SDK statement below is a source read, never a live measurement. “Std”
in a device request means the listed SDK or wyzr standard-body fields are
merged into that request. Secret-shaped literal values are intentionally not
reproduced.

| Call | (A) community SDK today | (B) wyzr ships at branch point | (C) 2026-09-02 baseline, including 09-10 correction |
|---|---|---|---|
| Login | `POST auth-prod.api.wyze.com/api/user/login`. Headers: `Accept-Encoding: gzip`, `User-Agent: wyze-sdk-<version>` (overrides the base okhttp value), JSON content type, `x-api-key`, `keyid`, `apikey`. Body: `nonce` string, `email`, triple-MD5 `password`. Reads top-level `access_token`; otherwise `mfa_options`, `mfa_details.totp_apps[0].app_id`, `sms_session_id`, `user_id`; response validation reads `code` or `errorCode`, then `msg` or `description`. [pinned SDK, 2026-09-12, (b)] | Same host/path/method. Headers: JSON content type, `keyid`, `apikey`. Body: exactly `email`, triple-MD5 `password`. Reads top-level `mfa_options`, `mfa_details.totp_apps[0].app_id`, `sms_session_id`, `access_token`, `refresh_token`, `errorCode`, `description`, `requestId`; retains HTTP status for diagnostics. [wyzr source, 2026-09-12, (b)] | Original said body also had `nonce`, described an `x-api-key`, and incorrectly put `keyid`/`apikey` in the body. Correction says the working real-account request had only `keyid`/`apikey`/content type headers and exactly `email`/`password` body; top-level tokens on success (RELAYED-measured), and top-level numeric `errorCode`/`description`/`requestId` on directly observed HTTP-400 errors (a). |
| MFA answer | SDK TOTP answer is `POST auth-prod.api.wyze.com/user/login` (**without `/api`**). Headers: `Accept-Encoding`, okhttp `User-Agent`, JSON content type, `x-api-key`; it does **not** re-add `keyid`/`apikey`. Body: `email`, triple-MD5 `password`, `mfa_type="TotpVerificationCode"`, `verification_id`, `verification_code`. Its SMS branch first makes the additional `POST /user/login/sendSmsCode` with query parameters `mfaPhoneType`, `sessionId`, `userId`, then posts the answer. [pinned SDK, 2026-09-12, (b)] | TOTP answer reuses `POST .../api/user/login`. Headers: JSON content type, `keyid`, `apikey`. Body: `email`, triple-MD5 `password`, `mfa_type="TOTP"`, `verification_id`, `verification_code`. Reads success/error fields as login does. SMS is rejected locally, so wyzr makes no send-SMS call. [wyzr source, 2026-09-12, (b); chosen path/shape remains (d)] | MFA existence and SDK-derived challenge reads were (b); the correction explicitly says no real challenge was observed and wyzr's answer shape remains (d). The baseline did not pin the SDK's distinct answer path, exact type literal, or missing credential headers. |
| Refresh token | `POST api.wyzecam.com/app/user/refresh_token`. Device headers: `Accept-Encoding: gzip`, okhttp `User-Agent`, JSON content type, `Connection: keep-alive`. Body: SDK Std (`access_token` from its client, `app_name="com.hualai"`, derived `app_ver`, app version, random UUID `phone_id`, `phone_system_type="2"`, `sc`, timestamp), plus endpoint-specific `sv` and `refresh_token`. It reads `data.access_token` and `data.refresh_token`; validator reads `code`/`msg`. [pinned SDK, 2026-09-12, (b)] | Same host/path/method. Only JSON content-type header. Body: wyzr Std (`sc`, one shared `sv`, `app_ver` and `app_name` naming the measured WyzeCam package, app version, deterministic derived `phone_id`, `phone_system_type="1"`, numeric timestamp), plus `refresh_token`, `keyid`, `apikey`; unlike the SDK helper it does not add the held `access_token`. Reads `code`, `msg`, `data.access_token`, `data.refresh_token`. [wyzr source, 2026-09-12, (b); standard body RELAYED-measured except derived phone id] | Refresh host/path and nested device envelope were (b), later retaining the device `{code,msg,data}` shape as directly observed (a). The correction says every device-host call requires the larger standard body, but this specific refresh request was not remeasured. |
| Device list | `POST api.wyzecam.com/app/v2/home_page/get_object_list`; device headers and SDK Std as above, plus endpoint-specific `sv`. Reads `code`/`msg`, then `data.device_list`; plug filtering reads `product_model`. [pinned SDK, 2026-09-12, (b)] | Same host/path/method; JSON content-type only; wyzr Std plus `access_token`. Reads `code`, `msg`, `data.device_list[]`, then each entry's `mac`, `product_model`, `nickname`, `conn_state`. [wyzr source, 2026-09-12, (b); request acceptance RELAYED-measured] | Endpoint and whole-account list were (b). Correction says the standard body was required and accepted (RELAYED-measured). It explicitly says real device-list content remained credential-gated/unobserved by this project's authors. |
| Property read | `POST api.wyzecam.com/app/v2/device/get_property_list`; device headers and SDK Std plus endpoint-specific `sv`, `device_mac`, `device_model`, `target_pid_list`. Reads `code`/`msg`, then returns `data`; plug code merges that object into its model. [pinned SDK, 2026-09-12, (b)] | Same host/path/method; JSON content-type only; wyzr Std plus `access_token`, `device_mac`, `device_model`, `target_pid_list` (normally `P3`,`P5`). Reads `code`, `msg`, `data.property_list[].pid` and `.value`, specifically P3 and P5. [wyzr source, 2026-09-12, (b); field names/list and string values RELAYED-measured] | Original table used bare `mac`/`model` and said a list of `{pid,value}` lived inside `data`; correction replaces request names with `device_mac`/`device_model`, confirms the standard body, and reports string P3/P5 values (RELAYED-measured). Device error envelope was directly observed (a). |
| Property write | `POST api.wyzecam.com/app/v2/device/set_property`; device headers and SDK Std plus endpoint-specific `sv`, `device_mac`, `device_model`, `pid`, and `pvalue=str(value)`. Plug on/off supplies P3 with Python integer 1/0, converted to JSON string `"1"`/`"0"`. Reads `code`/`msg`; callers receive the response. [pinned SDK, 2026-09-12, (b)] | Same host/path/method; JSON content-type only; wyzr Std plus `access_token`, `device_mac`, `device_model`, `pid`, `pvalue` constrained to string `"0"`/`"1"`. Reads `code`, `msg`, returns `data`; the CLI then performs one property read-back. [wyzr source, 2026-09-12, (b); request fields/value RELAYED-measured] | Original said bare `mac`/`model`, field `value`, integer 0/1. Correction says `device_mac`/`device_model`, `pvalue`, and string `"0"`/`"1"` (RELAYED-measured); this outranks the original inference from the SDK's internal `PropDef("P3", bool, int, [0,1])`. |

## Material disagreements and precedence decisions

**SDK versus live-measured login.** The SDK sends `nonce`, a static
`x-api-key`, and an SDK user agent. The 2026-09-10 relayed successful login
recorded the complete working headers as `keyid`, `apikey`, and content type,
and the body as only `email` and `password`. wyzr correctly follows the
live-measured shape; no code change is warranted from the SDK source alone.
[SDK source 2026-09-12, (b), versus 2026-09-10 RELAYED-measured request]

**SDK versus live-measured device standard body.** The SDK source supplies
endpoint-specific `sv` values, `app_name="com.hualai"`, an app-ver derived
from it, and `phone_system_type="2"`. The relayed working calls accepted one
different `sv`, WyzeCam-qualified app name/app-ver, and
`phone_system_type="1"` across the calls recorded in wyzr. wyzr retains the
relayed values. This proves only that those values were accepted; it does not
prove the SDK's alternatives are refused or that every endpoint requires one
shared `sv`. [SDK source 2026-09-12, (b), versus 2026-09-10 RELAYED-measured;
last sentence (d)]

**MFA remains an assumed disagreement, not a measurement.** The SDK's TOTP
answer uses `/user/login`, literal `TotpVerificationCode`, `x-api-key`, and no
user `keyid`/`apikey`; wyzr uses `/api/user/login`, literal `TOTP`, and the
user key headers. No real MFA challenge or answer has been observed anywhere
in this project. The SDK is better source evidence than wyzr's inference, so
this is a high-priority input to the sibling fail-loud decoder work, but the
ticket forbids changing code here and source alone must not be presented as
proof of the live wire. [SDK and wyzr source, 2026-09-12, (b) versus (d)]

**Refresh has unresolved extra-field differences.** The SDK injects the
current access token and an endpoint-specific `sv`; wyzr sends developer
`keyid`/`apikey` and its common standard `sv`. The historical correction says
this specific call was not remeasured. Neither implementation should be
declared correct from this comparison alone. [SDK and wyzr source,
2026-09-12, (b); conclusion (d)]

The SDK and live relay now agree on the important property-call corrections:
`device_mac`, `device_model`, `target_pid_list`, `pvalue`, and string power
values. That agreement independently corroborates but does not upgrade the
relay into a direct observation by this task. [SDK source 2026-09-12, (b),
and 2026-09-10 RELAYED-measured]

## What I could not determine

- Whether either MFA answer shape works, the complete MFA response, or
  whether SMS answering needs calls beyond the SDK flow. No real challenge
  has been observed. [2026-09-12, (d)]
- Whether the SDK's or wyzr's differing app identities, headers, and `sv`
  values are required, merely accepted, or currently rejected. Testing
  alternatives needs controlled authenticated calls forbidden here.
  [2026-09-12, (d)]
- The live refresh request/response shape, including whether `access_token`,
  `keyid`, or `apikey` is required in addition to `refresh_token`.
  [2026-09-12, (d)]
- Any complete current real device-list payload, model coverage beyond the
  pinned sources, or whether a property write takes effect. These require an
  account/device and were not tested. [2026-09-12, (d)]
- Headers on the previously relayed device calls. Absence from a transcript
  is not evidence that a header was absent on the wire. [2026-09-12, (d)]

## Checks and falsification criteria

- **Reference currency:** `gh api` plus `git ls-remote`, followed by a detached
  checkout. Failure: archived metadata, a remote SHA different from the
  checkout, stale maintenance, or absent plug read/write implementation.
  Result: unarchived, exact SHA matched, plug support present. [2026-09-12]
- **Call completeness:** searched all `src/` files for network primitives,
  hosts, paths, and transport methods, then followed the common request
  function. Failure: any Wyze host/call site not represented by the six rows,
  or a transport method with no row. Result: none. [2026-09-12]
- **Baseline gates:** after a frozen dependency install, ran `bun run
  typecheck`, `lint`, `check:no-console`, and `test:coverage`, capturing each
  command's own exit code. Failure: any nonzero exit. Result: 0, 0, 0, 0 at
  the untouched branch point. [2026-09-12]
- **Scope:** compare the branch against `origin/WYZR-34`. Failure: any changed
  file outside this new dated document, especially under `src/` or `test/`,
  or any byte change to the 2026-09-02 finding. Result after commit: the diff
  contains only this new dated document; the `src/` and `test/` diff is empty;
  and the 2026-09-02 finding is byte-unchanged. [2026-09-12]
- **No-credential rule:** no probe was run. Failure: any network request to a
  Wyze API host, acquisition/use of credentials, or device toggle. Result:
  none. [2026-09-12]
- **WYZR-20 collision check:** inspected `git diff --stat
  origin/main...origin/WYZR-20`. Failure for this task: a need to edit one of
  its overlapping non-doc files. Result: WYZR-20 changes 48 files, including
  config/doctor/capture work, but this task edits only this new document, so
  overlap is nil. [repository refs read 2026-09-12, tier (b)]
