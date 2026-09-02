# What the Wyze API actually is — findings, 2026-09-02

Research-only finding for [WYZR-5]. No code, no transport design. Zero Wyze
credentials obtained, zero authenticated calls made, zero Wyze accounts
created — this document is built entirely from public documentation, public
repositories, and public forum threads.

Confidence tiers used throughout:
- **(a)** documented by Wyze officially
- **(b)** implemented in community code that appears actively maintained
- **(c)** asserted in an issue thread, forum post, or blog by one person
- **(d)** the author's inference

## 0. Falsification criteria (written before looking at any finding)

**H1 — "Wyze has NO official public device API."** Falsified if an official
Wyze surface (a `wyze.com`, `support.wyze.com`, or `developer-api-console.wyze.com`
page) presents a formal, versioned device-control API — an endpoint list with
request/response schemas and auth scopes — explicitly offered to third-party
developers (e.g. a "Wyze for Developers" program with terms of service for
programmatic device control). Not falsified if the only official surface is
account-scoped API-key *issuance* with no accompanying endpoint documentation,
and independently maintained SDKs still describe their own work as
reverse-engineered.

**H2 — "Community SDKs work through reverse-engineered endpoints, combined
with official API-key auth (key ID + secret) alongside the account email."**
Falsified if the current, actively maintained `wyze-sdk` does not require a
Wyze-issued API key ID/secret at all, or requires something categorically
different (OAuth, a hardware pairing token, etc). Confirmed-with-correction if
the key ID/secret is used but the real login call needs strictly more than
H2 states.

**H3 — "The reference implementation is the community Python `wyze-sdk`."**
Falsified if that repository is archived, has had no commits or releases in
a long window (e.g. 6+ months), or a clearly more current/complete
alternative has superseded it as the de facto reference for the plug device
class. Confirmed if it is not archived, has recent commits/releases, and
remains the most complete Python client for plugs.

## 1. Headline

**H1: CONFIRMED.** No official Wyze public device API exists today.
**H2: MOSTLY CONFIRMED, WITH A MATERIAL CORRECTION.** A Wyze-issued API key
ID/secret is real and is used as hypothesized — but the login call still
requires the account **password** too (not email alone), MFA can be
triggered, and there is a **second, separate, non-user-specific key baked
into the SDK's own source** that identifies the calling app/library — H2
described one key; there are really two, of different kinds.
**H3: CONFIRMED.** `shauntarves/wyze-sdk` is alive and released as recently
as five business days before this research.

The operator's mental model is directionally right and safe to build on. The
one correction that matters for the downstream auth story: budget for
password storage and MFA handling, not just a key ID/secret pair.

## 2. Findings, by question

### Q1 — Does an official Wyze device API exist today?

No. Two independent, actively-maintained sources say so directly:

- The `wyze-sdk` README (read 2026-09-02, at commit `2d73bfd1c714fb165b9b091b6b493f93fd1245dd`
  of `github.com/shauntarves/wyze-sdk`, master branch): *"Wyze does not
  provide a Web API that gives you the ability to build applications that
  interact with Wyze devices. This Development Kit is a reverse-engineered,
  module-based wrapper that makes interaction with that API possible."* (b)
- Two Wyze community-forum threads, neither of which drew a reply from any
  Wyze staff/moderator account (checked 2026-09-02):
  [API Access and Custom Software Development for Wyze Sensor](https://forums.wyze.com/t/api-access-and-custom-software-development-for-wyze-sensor/283459) —
  a community member states *"Wyze does not currently have a publicly
  documented API, though there is a portal to generate an API key"* and
  *"Wyze does not intend on creating a public api."* (c)
  [Wyze REST API documentation and local IP access](https://forums.wyze.com/t/wyze-rest-api-documentation-and-local-ip-access/294323) —
  a community member states Wyze does *"not want to dedicate resources
  towards creating public documentation."* (c)

What *does* exist officially: an account-scoped **API key issuance**
console at `developer-api-console.wyze.com`, and one Wyze support article,
["Creating an API Key"](https://support.wyze.com/hc/en-us/articles/16129834216731-Creating-an-API-Key).
This is key *management*, not endpoint documentation — I found no official
page describing what the key can be used to call.

Two explicit gaps in my own research, named rather than smoothed over:
`developer-api-console.wyze.com` returned only a page title to my fetch tool
(it appears to be a JS-rendered single-page app I could not read further —
"could not reach the content," not "the page says nothing"); the support
article returned HTTP 403 to my fetch tool, so its content here is via a
search engine's cached snippet, not a direct read — flagged again under Q3
where its numbers matter most.

Where I looked for a positive hit on "official API exists" and found none:
Wyze's own developer/support surfaces, and the READMEs of both major
community SDKs — which would be the first to link to an official spec if one
existed, since it would make their reverse-engineering moot. None do.

### Q2 — Current state of `wyze-sdk` and the wider ecosystem

`shauntarves/wyze-sdk`: not archived, default branch `master`, last push
`2026-08-31T14:46:36Z`, latest release `v2.3.8` published `2026-08-20T20:09:35Z`
(also on PyPI same day), 51 open issues. (b, `gh api`, read 2026-09-02)

Its auth section still matches H2's shape (email/password, optional
key ID/API key from the same developer console) — see Q3 for the correction
the source code reveals underneath that README description.

Open issues worth naming: **#199**, "Developer API login returns errorCode
1000 with valid credentials" (opened 2026-04-27, still open as of 2026-09-02)
— **correction from an earlier draft of this document, which wrongly said
"zero replies" and "not acknowledged by a maintainer."** It has one reply
(2026-04-28), from a **COLLABORATOR** on the repo — maintainer-level. That
reply identifies a specific, actionable cause: an account created via
Google or Apple SSO has no Wyze-native password, so there is nothing for
the SDK's triple-MD5 chain to hash, and the login call returns errorCode
1000 — the same code it returns for a genuinely wrong password. The fix is
to set a Wyze-specific password in the Wyze app (Account → Security) and
use *that* as the input to the hash, not the SSO provider's password. This
is a **provisioning prerequisite** for whoever creates the account this
project will use — see §4 and §5. The same reply also states that
`key_id`/`api_key` have been **mandatory since July 2023**, independently
corroborating H2. (b — a maintainer-level reply on an actively maintained
repo, read 2026-09-02)
**#182**, "occasional service unavailable 503 errors" — **correction: opened
`2024-06-27`, not `2026-06-27`** as an earlier draft of this document said
(a two-year date error). A two-year-old, still-unresolved report of
occasional 503s is a weaker signal than a two-month-old one; treated
accordingly here. (c)

The wider ecosystem is alive too, not just this one repository:
`SecKatie/wyzeapy` pushed `2026-08-31` (b); `SecKatie/ha-wyzeapi`, a Home
Assistant integration, pushed `2026-09-02` — the same day as this research —
with 33 open issues, not archived (b). A dead SDK with a live successor
would have been a materially different, worse finding than what I found: a
live SDK inside a live surrounding ecosystem.

### Q3 — The actual auth flow (the corrected part)

Endpoint: `POST https://auth-prod.api.wyze.com/api/user/login`. (b, from
`wyze_sdk/service/auth_service.py` at the commit above, read 2026-09-02)

Body fields: `email`, `password` — the SDK does **not** send the raw
password; it sends it through MD5 three times chained
(`md5(md5(md5(password)))`) — plus a request `nonce`. (b)

Two distinct credential-like values are involved, not one:

1. `keyid` / `apikey` — the user's own Developer API Key ID + Secret,
   generated from `developer-api-console.wyze.com`, sent as extra fields on
   the login call. This matches H2. (b)
2. An `x-api-key` header — a **separate, fixed, non-user-specific** value
   that is hardcoded directly into the `wyze-sdk` source itself. It
   identifies the calling SDK/app, not the end user. H2 did not anticipate
   this. **I am deliberately not reproducing its value anywhere in this
   document** (it is a credential-shaped string embedded in open-source
   code, and this task's hard constraint bars reproducing anything
   credential-shaped, example or otherwise) — its *existence and role* is
   itself the finding, not its literal contents. I cannot verify from
   reading alone whether Wyze still honors that exact static value; that
   would require an authenticated call, which is out of scope here. (b for
   the field and its use; d for whether it still works today)

MFA: the login call can return a TOTP or SMS multi-factor challenge that
must be answered before tokens are issued. (b)

**Provisioning prerequisite, corrected in from the Q2 review above: the
account must have a Wyze-native password.** A Google/Apple-SSO-only Wyze
account has no password for the triple-MD5 chain to hash, and the login
call fails with the same errorCode 1000 as a wrong password — indistinguishable
from a credentials typo without knowing this. Confirm in the Wyze app under
Account → Security before provisioning: if there is no "Change Password"
option, the account is SSO-only and needs a Wyze-specific password set
first. (b, `shauntarves/wyze-sdk` issue #199, comment from a repo
COLLABORATOR, read 2026-09-02)

Tokens returned: `access_token` and `refresh_token`, both long opaque
strings (the README documents their prefix format; I am not reproducing an
example token string here). (b)

Expirations, per the Wyze support article "Creating an API Key": access
token ~2 days, refresh token ~30 days, the Developer API Key itself ~1 year
from creation. **Confidence downgraded**: I could not fetch that page
directly (HTTP 403), so this is via a search engine's cached snippet of
official content, not a direct read of the live page — treat as (b/c) until
someone with direct browser access confirms it verbatim.

Refresh: use the refresh token against `/app/user/refresh_token` on
`api.wyzecam.com` rather than re-running the login/password flow — the
SDK's own README calls the always-login-per-call pattern "deprecated due to
issues with authentication rate limiting." (b)

Response envelope, for every call (auth and device alike):
`{"code": ..., "msg": ..., "data": {...}}`, where `code == 1` (as a string)
means success; `code == 1000` covers invalid-credentials / too-many-failed-
attempts; `code == 2001` (or `msg == "AccessTokenError"`) means the access
token expired and must be refreshed. (b, `wyze_sdk/service/wyze_response.py`)

### Q4 — Endpoints for the four operations `wyzr` needs

Hosts observed in the actively-maintained SDK source (b): auth on
`auth-prod.api.wyze.com`; the main device/app API on `api.wyzecam.com`.
(Also present in the source but irrelevant to plugs: a platform-profile host
and a scale/health-telemetry host.)

| Operation | Call | Notes |
|---|---|---|
| List devices | `POST /app/v2/home_page/get_object_list` on `api.wyzecam.com` | Returns the whole account's device list, not plug-scoped. |
| Read plug state | `POST /app/v2/device/get_property_list` (single) or `.../device_list/get_property_list` (batch) | Takes `mac`/`model` (or `device_ids`) plus `target_pids` — you ask for specific property IDs, there is no generic "status" field. |
| Turn on | `POST /app/v2/device/set_property` or `.../set_property_list` | `mac`, `model`, `pid="P3"`, `value=1`. |
| Turn off | same endpoint | `pid="P3"`, `value=0`. |

**The nuance the ticket asked me to nail down**: plug on/off is **PID
`"P3"`**, wire-encoded as an **integer, 0 or 1** — not a native JSON boolean
and not a free-form string. The SDK's own type declaration is
`PropDef("P3", bool, int, [0, 1])`: "presented to Python callers as a
`bool`, but the wire type is `int`, restricted to exactly two values." (b,
`wyze_sdk/models/devices/base.py`, same commit) Any client that assumes a
native boolean, or a `"true"/"false"` string, on the wire will be silently
wrong.

Two more PIDs from the same table worth carrying into the transport design:
`P1` = push-notifications-enabled, `P5` = online/reachability state (also
int 0/1) — `P5` matters a lot for a safety-critical tool, because it lets
`wyzr` distinguish "the plug is off" from "the plug is unreachable," which
`P3` alone cannot do. (b)

Response shape for a property-list read is, per the SDK's own parsing code,
a **list** of `{"pid": ..., "value": ...}` entries inside `data`, not a flat
map. I did not find a captured example of the full, real JSON (field
ordering, exact casing, wrapper keys beyond `pid`/`value`) in any tier
(a) or (b) source — see §3.

### Q5 — Failure and hazard modes

**Total cloud dependency; no local-control fallback found for plugs.** I
looked specifically for a LAN/local protocol — the kind that exists for
Wyze *cameras* via community bridges such as `docker-wyze-bridge` — and
found none for plugs; `docker-wyze-bridge` itself is a camera-stream-only
project. Every one of the four operations `wyzr` needs goes through
`api.wyzecam.com` / `auth-prod.api.wyze.com`. **If the Wyze cloud is
unreachable, `wyzr` cannot read or change plug state at all** — there is no
fallback path I could find. This is the single fact most relevant to the
downstream safety-critical epic. (d — negative/absence-based finding; see
§3 for exactly what a positive result would have looked like)

**Wyze has changed auth requirements before, without a compatibility path
for old clients.** A widely used community wiki notes that "as of April
2024, it is strongly recommended to create and use an API Key and ID for
compatibility with changes to the Wyze Authentication API" — i.e. Wyze
changed what auth it accepts at some point, and password-only clients had
to adapt. (c) Treat this as a standing risk, not a one-time historical
event — nothing here suggests it can't happen again.

**Rate limiting exists on the login endpoint** (Q3) — repeated re-auth is
explicitly called unsafe by the SDK's own maintainer. `wyzr`'s transport
should authenticate once and hold/refresh tokens, never re-login per call. (b)

**Token lifetimes are short relative to "rare emergency use."** If the
access token (~2 days, held at reduced confidence — see Q3) expires between
infrequent power-cycle events, the transport needs a refresh-token flow
(~30 days) that is *tested well before* the emergency, not discovered to be
broken at the moment the operator's box has already frozen. (b/c)

**Unconfirmed but live reliability reports exist**: occasional 503s (#182)
and one uncorroborated login failure report (#199) — neither confirmed
systemic, both worth re-checking at implementation time. (c)

**Regional endpoints: UNKNOWN.** No source I read — official or community —
mentioned region-specific hosts for auth or device calls, positively or
negatively. Closing this needs either an official doc (which doesn't exist)
or a real account to test against.

**Exact plug hardware/firmware matters.** `P3`/`P5`/`P1` are confirmed for
the plug device classes the SDK models (`WyzePlug`, `WyzePlugOutdoor`), but
PID sets can differ by model/firmware generation — the SDK's own source
carries open comments like "WHAT IS P7?" next to this table, i.e. even the
actively-maintained reference has acknowledged gaps in it. (b)

### Q6 — Maintained TypeScript/JavaScript client?

No TypeScript Wyze device-control client was found. A GitHub code search for
`wyze language:typescript` (run 2026-09-02) returned no genuine Wyze API
client — only unrelated projects using "Wyze" as a UI/branding reference. A
positive hit would have looked like a repo whose description or README
described talking to Wyze's device API. (b)

Two unofficial **JavaScript** (not TypeScript) wrappers exist and are
actively maintained: `jfarmer08/wyze-api` (pushed 2026-08-29, 3 open
issues, not archived) and `noelportugal/wyze-node` (pushed 2026-06-25, 0
open issues, not archived). (b) I could not fetch their npm pages directly
(blocked) to confirm whether either ships `.d.ts` type declarations; GitHub
reports both as language "JavaScript," a strong but not conclusive signal
of no bundled types. Explicit unknown — see §3.

**Recommendation**: implement `wyzr`'s transport directly in TypeScript
against the four raw HTTP calls in the table above, rather than wrapping
either JS package. Reasoning: (1) neither existing JS package is
TypeScript, so wrapping one buys no type safety for a dependency of unclear
maintenance depth, on a surface this narrow (four calls); (2) the Python
`wyze-sdk` is the more complete, more actively maintained reference for
*behavior* (auth flow, PID semantics, error codes) and should be read as
the de facto spec even though `wyzr` will not depend on it directly; (3) a
from-scratch TypeScript transport can encode the `P3`-is-int-not-bool
nuance, the two-tier key/app-key distinction, and the token-refresh
discipline explicitly in its own types, instead of inheriting an untyped JS
library's assumptions. (d — this is a recommendation, not a fact, grounded
in the (b)-tier findings above)

## 3. Explicit unknowns, and what would close each

1. **Exact live response JSON** (field names, casing, nesting) for
   `get_object_list` / `get_property_list` / `set_property_list` — needs
   either an authenticated call (out of scope for this task) or someone
   else's already-published worked example; I did not find one in any tier
   (a)/(b) source.
2. **Whether the provisioned account will hit MFA**, and which kind — is
   account-specific and unknowable until the account exists.
3. **Exact token lifetimes** — held at reduced confidence because the one
   page stating them returned HTTP 403 to my fetch tool; I relied on a
   search-engine snippet, not a direct read. Someone with real browser
   access should re-confirm verbatim on the live page.
4. **Regional endpoint variation** — no source mentioned it either way; not
   "checked and found none," genuinely never came up.
5. **Rate-limit thresholds** (requests/minute etc.) — no source publishes a
   number, only qualitative warnings.
6. ~~**Whether issue #199 is a real, current, systemic login failure** or a
   one-off — zero replies, no maintainer acknowledgment as of 2026-09-02.~~
   **Substantially answered on review** (this document originally got the
   reply count on #199 wrong): a maintainer-level reply names a specific,
   non-systemic cause (SSO-only accounts have no native password to hash —
   see Q3) and a specific fix. What remains genuinely open: whether *any*
   separate, systemic login failure exists beyond that one explained case —
   nothing in the thread suggests one, but the absence of further reports
   is not strong evidence either way this soon after the explanation was
   posted.
7. **Whether `jfarmer08/wyze-api` or `noelportugal/wyze-node` ship
   TypeScript type declarations** — blocked by npm fetch failures during
   this research; a direct `npm view <pkg> types` (or equivalent) would
   close this quickly.
8. **`developer-api-console.wyze.com`'s full page content once logged in**
   — my fetch tool returned only the page title; the console appears to be
   a JS-rendered SPA I could not read further. What I know about it comes
   from the SDK/support-article sources describing it (key creation, one
   key per user, ~1 year validity), not from reading the console itself.
9. **Whether there is truly zero local-control path for plugs**, or one
   simply undocumented and unused by the ecosystem I surveyed — I searched
   the same community ecosystem that documents camera local-streaming
   (`docker-wyze-bridge`) and found nothing analogous for plugs; that is
   absence-of-evidence from a reasonably thorough search, not proof of
   absence.

## 4. Recommendation for the transport story

**Provisioning prerequisite (see Q3): before the account email/password/API
key are issued to this project, confirm the account has a Wyze-native
password** (Wyze app → Account → Security → "Change Password" present), not
only Google/Apple SSO — otherwise the very first login attempt will fail
with errorCode 1000 in a way that is indistinguishable from a wrong
password or a broken transport, and will burn debugging time on the wrong
layer.

Build the TypeScript transport directly against `api.wyzecam.com` /
`auth-prod.api.wyze.com` per the endpoint table in Q4, using the Python
`wyze-sdk` source as the behavioral spec rather than wrapping either
existing JS package (Q6). It must implement: the triple-MD5 password hash;
dual-key auth (the user's own key ID/API key from the developer console,
**and** a static app-identity key that `wyzr` should mint/derive for
itself rather than copying one out of another open-source project's
history); MFA handling; token refresh well before the ~2-day/~30-day
windows expire (§2/Q3, reduced-confidence numbers); `P3` as `int`-not-
`bool` and `P5` for reachability, not just `P3` for state; and — most
important for the safety-critical epic this all serves — treat Wyze cloud
reachability itself as a **monitored precondition**, not an assumption,
since no local fallback exists for plugs (Q5).

## 5. What cannot be known without credentials

- Whether login with a real, Wyze-native-password account and a real API
  key succeeds today (the SSO-account failure mode in §2/Q3 is now
  explained and avoidable by construction, but it is not the same as a
  confirmed successful login).
- Real response payload shapes.
- Real MFA behavior for the specific account that will be provisioned.
- Real token-refresh behavior/timing in practice, versus the documented
  (reduced-confidence) numbers above.
- Whether the operator's specific plug hardware/firmware exposes exactly
  `P3`/`P5`/`P1` or a different PID set.
- Real rate-limit behavior under actual repeated calls.

None of these can be closed by reading documentation, because no official
documentation exists (Q1) — closing them requires the provisioned account
and a first authenticated call, which is explicitly out of scope for this
task.
