# Probing Wyze's real error envelopes without an account

This procedure needs **no Wyze account, no real credentials, no hardware,
and no human at Wyze's end**. It sends a well-formed request carrying
obviously-fake, placeholder values to a real Wyze host and reads back
whatever error envelope comes back. That is enough to observe the SHAPE of
an error response — which is exactly the thing every fake-transport test
in this repo (`src/transport-fake.ts`) can never prove, because a fake
only tests that this project's code agrees with this project's own belief
about the shape, never that the belief itself is correct.

WYZR-15 exists because this was never done for the auth host before it:
`docs/wyze-api-findings-2026-09-02.md`'s §Q3 asserted one envelope shape
"on every call, auth and device alike" from reading a community SDK's
source, and nobody spent the one call needed to check it. The auth host's
real error shape turned out to be completely different (see that
document's 2026-09-10 correction, and `src/wyze-auth-envelope.ts`'s header
comment) — and because this project's own code silently applied the wrong
envelope's field names to it, wyzr most likely could not log in at all,
even with a correct password. **Run this procedure again whenever a
provenance-tagged fixture in `src/transport-fake.ts` is still tagged
`PROVENANCE: ASSUMED` for something that is actually cheap to check this
way** — an unchecked belief is a bug waiting for someone to hand it real
credentials to discover it.

## ⚠️ Rate-limit caution — read this before running anything

`docs/wyze-api-findings-2026-09-02.md` §Q5 names login-endpoint rate
limiting as a specific, real hazard, and `src/transport-http.ts` deliberately
contains **no retry anywhere**, for exactly this reason. This procedure is
a **small, COUNTED, manual set of individual calls** — never a loop, never
a script that retries automatically, never run on a schedule or in CI.

- Plan the whole sequence of calls you intend to make BEFORE you make the
  first one, and keep a running count.
- Space calls out; do not fire them back-to-back in a tight loop.
- If any response looks like throttling (an HTTP 429, a message
  mentioning rate limits, or a response shape that doesn't match anything
  below), **STOP immediately** and report it — do not retry to "confirm"
  it, and do not keep probing to work around it.
- Treat every call this procedure makes, PLUS every live end-to-end CLI
  run (`wyzr devices list` against a real host with placeholder
  credentials) as spending from the **same shared budget** — both hit the
  same real hosts.
- WYZR-15's own budget, for reference (2026-09-10): 3 calls already made
  by earlier agents on this epic before this ticket started, plus this
  ticket's own 2 required reproductions (one per host), a 3-probe sweep
  (a missing field, a malformed body, a bad keyid), and 2 end-to-end CLI
  runs (before and after the fix) — 7 calls from this ticket, on top of
  the 3 already spent. That is the right ORDER OF MAGNITUDE for "a
  handful" — not a hard cap, but a sense of scale.

## What you need

- The auth host and login path, and the device host and one device-call
  path: `WYZE_AUTH_HOST`/`WYZE_LOGIN_PATH`/`WYZE_API_HOST`/
  `WYZE_GET_PROPERTY_LIST_PATH` in `src/transport.ts` — read them from
  that file at whatever commit you're on, don't copy the values from this
  document (they could move).
- The exact request shape `RealWyzeTransport` sends (`src/transport-http.ts`
  — read it at your own commit, this document only summarizes): the auth
  host (`login()`/`submitMfa()`) takes `keyid`/`apikey` as HEADERS
  alongside `content-type: application/json`, with a body of just
  `{"email": ..., "password": ...}` — no `x-api-key` header, no `nonce`
  (both retired by WYZR-15 — see `src/transport.ts`'s `LoginRequest` doc
  comment). The device host (every other call) needs
  `src/wyze-device-identity.ts`'s `deviceStandardBody()` fields
  (`sc`/`sv`/`app_ver`/`app_name`/`app_version`/`phone_id`/
  `phone_system_type`/`ts`) merged into the body — read the exact values
  from that file, don't copy them from this document (they're public app
  identity, not secret, but keeping one source of truth avoids drift).
- `curl`, or equivalent.

## Placeholder values — never anything real

Every credential-shaped field in every request below MUST be an
obviously-fake placeholder: a `.invalid` email, an all-zero UUID for
`keyid`, a long run of zeros or another obviously-synthetic string for
`apikey`/`password`. **Never** a real email, a real password (even one you
intend to change), or a value copied from any real account. This procedure
proves nothing about whether a *specific* credential is valid — it only
proves what SHAPE an error/success response takes. Never commit a raw
transcript containing anything that isn't obviously a placeholder; if a
response ever contains a token-shaped value, treat it as a secret and
never print or commit it (see `src/redact.ts`) even though a placeholder
call is not expected to ever produce a real one.

## Procedure

1. **State your falsification criterion before you run anything.** For
   the auth-host error shape, that's: a top-level `code` field, or the
   ABSENCE of `errorCode`/`description`. For the device-host error shape:
   the ABSENCE of a top-level `code` field. If you get the falsifying
   result, STOP and say so rather than proceeding as if the belief you
   were checking still holds.

2. **Auth host — invalid credentials.** `keyid`/`apikey` are HEADERS on
   this host, not body fields (WYZR-15's correction — an earlier version
   of this procedure got that wrong the same way the product's own code
   did, and the resulting HTTP 400 was a true observation of THIS host's
   error shape reached through a request this host itself does not
   consider well-formed — see `docs/wyze-api-findings-2026-09-02.md`'s
   §Q3 correction for the full account of that mixup):

   ```sh
   curl -sS -w '\nHTTP_STATUS:%{http_code}\n' -X POST \
     -H 'content-type: application/json' \
     -H 'keyid: 00000000-0000-0000-0000-000000000000' \
     -H 'apikey: <64+ zeros or similar>' \
     -d '{"email":"probe@example.invalid","password":"<64+ zeros or similar>"}' \
     "https://$WYZE_AUTH_HOST$WYZE_LOGIN_PATH"
   ```

   Expect (per WYZR-15's own reproduction, 2026-09-10, against the
   PRE-correction body-field shape — reproduce this again against the
   corrected header shape above if you want a fresh, well-formed-request
   observation, which nobody has recorded yet): HTTP 400, a body with
   exactly `description`/`requestId`/`errorCode` at the top level,
   `errorCode` as a JSON NUMBER. Record the raw response and HTTP status,
   AND which request shape (headers vs body) you used — that distinction
   turned out to matter enormously (see criterion 1 in the ticket that
   likely sent you here).

3. **Device host — a representative device call.** Needs the full
   standard body (`src/wyze-device-identity.ts`'s `deviceStandardBody()`),
   not just the call's own fields — a bare `{access_token}` body is
   REJECTED (see step 3's own expected output below for exactly how):

   ```sh
   curl -sS -w '\nHTTP_STATUS:%{http_code}\n' -X POST \
     -H 'content-type: application/json' \
     -d '{"sc":"<from src/wyze-device-identity.ts>","sv":"<from src/wyze-device-identity.ts>","app_ver":"<from src/wyze-device-identity.ts>","app_name":"<from src/wyze-device-identity.ts>","app_version":"<from src/wyze-device-identity.ts>","phone_id":"<any string>","phone_system_type":"1","ts":<epoch ms>,"access_token":"invalid-placeholder-token","device_mac":"00:00:00:00:00:00","device_model":"WLPP1","target_pid_list":["P3"]}' \
     "https://$WYZE_API_HOST$WYZE_GET_PROPERTY_LIST_PATH"
   ```

   Expect: HTTP 200, a body with `code`/`msg`/`data` at the top level,
   `code` as a STRING. (A bare `{"access_token":"..."}` body, this
   project's pre-WYZR-15 shape, instead returns HTTP 200,
   `{"code":"1001","msg":"INVALID_PARAMETER"}` — a body-shape error, not a
   credentials error, which is itself worth confirming if you're
   re-deriving this from scratch.)

4. **A small, planned sweep of variations, if and only if it's cheap and
   answers a real open question** — e.g. a missing required field, a
   malformed (non-JSON) body, a plainly-bad `keyid`. Decide the full list
   before step 2, not as you go. WYZR-15's own sweep (2026-09-10) found
   the SAME `{description,errorCode,requestId}` shape held across a
   missing-password call (`errorCode: 5000`, "Internal Error") and a
   bad-keyid call (`errorCode: 1000`, same as invalid credentials); a
   malformed (non-JSON) body returned HTTP 400 with an EMPTY body (already
   handled by `RealWyzeTransport`'s existing non-JSON-response error path,
   nothing new to design for).

5. **Update, don't just read.** If a response's shape differs from what
   `src/wyze-envelope.ts`/`src/wyze-auth-envelope.ts` currently model,
   that's a real finding — file it (or fix it, if it's in scope for
   whatever ticket sent you here), update the relevant `PROVENANCE`-tagged
   fixture in `src/transport-fake.ts` to match, and correct
   `docs/wyze-api-findings-2026-09-02.md` in place, dated, with its
   confidence tier, the same way every other claim in that document is
   recorded.

## Specify a discriminator, not just a shape

When you write down what evidence a piece of work must produce, specify at
least one component the specification itself cannot supply. Otherwise the
specification has published its own answer key, and a transcript satisfying
it is indistinguishable from a transcript reciting it.

For anything in this repo that records a live run, the concrete form of
that rule is: capture at least one thing that could not have been
predicted in advance. Any of these is sufficient, more than one is better:

- the command's own wall-clock latency (a real round trip cannot be zero)
- an absolute timestamp from the machine's own clock at the moment of run
- the exact `git rev-parse HEAD` of the working tree at run time
- a server-generated correlation id, if any code path surfaces one

**Worked example.** WYZR-14's criterion 9 required an end-to-end
before/after CLI run to prove the errorCode-1000 decode fix, and then
stated the expected output verbatim: `Wyze API returned an error (code
undefined).` and exit 6. The first before/after pair offered as evidence
was therefore reconstructable from the ticket text alone and proved
nothing about execution. There was no discriminator available inside the
output either: the auth host's `requestId` (step 2 above) is one-time per
call, but neither the pre-fix generic error nor the post-fix credentials
message prints it. The pair was re-run, and the second one carried
timestamps and two independently-verifiable commit SHAs in two separate
worktrees. The defect was in the instrument — the acceptance criterion
itself — not in anyone's claim, which is what made it worth recording
here.

Surfacing the auth host's `requestId` in an error message would make this
class of check self-verifying, and would be independently useful for a
support trail — but that's a `src/` change with its own consequences (see
the redaction constraints above), and is deliberately not done as a side
effect of writing this section. File it if you think it should happen.

## What this procedure cannot do, and what actually needed a real account

This procedure — junk credentials against a real host — can only ever
observe how a host reacts to a request it REJECTS. It cannot, even in
principle, observe what a host does when it ACCEPTS a request: a
successful login, a real MFA challenge, real device data, or a real write
actually taking effect. Those needed a provisioned, working account, full
stop — no amount of cleverness with placeholder credentials substitutes
for one. This project has never had one and will not create one (see the
ticket that sent you here). WYZR-15 draws this line explicitly, dated,
because "nothing can be checked without credentials" was FALSE for the
error-shape half of this API and that false belief shipped a real defect
— but the line still exists, it was just drawn in the wrong place before:

**Checkable for free with THIS procedure (no account, ever) — and now
checked:**
- The auth host's error envelope shape (`description`/`errorCode`/
  `requestId`, HTTP 400) — tier (a), this project's own direct
  observation, reproduced three times plus a small sweep.
- The device host's error envelope shape (`{code,msg,data}`, HTTP 200) —
  tier (a), this project's own direct observation.
- That the device host requires ITS OWN request to carry a
  correctly-shaped body at all (the `{access_token}`-alone rejection,
  and the `device_mac`-missing rejection) — tier (a), same reason.

**GENUINELY credential-gated — no free-request trick reaches these, and
the shapes below came from a REAL account via relay, not from this
project's own observation (see each shape's own PROVENANCE tag in
`src/transport-fake.ts` for the precise wording):**
- The auth host's SUCCESS response shape (tokens at the top level,
  `user_id`, the `_options`/`_details`/`_session_id` fields present but
  `null` on a non-MFA account) — needed a login that actually SUCCEEDS,
  which needs a real password that actually authenticates.
- Confirmation that the device-host standard body's specific values
  (`sc`/`sv`/`app_ver`/...) are ACCEPTED — a rejected request tells you
  a body is malformed, never that a DIFFERENT body would have been
  accepted; only a request that actually succeeds proves a shape works.
- The real `get_object_list`/`get_property_list` response CONTENT for an
  actual device (field values, not just field names/types) — junk
  credentials never reach a device list at all.
- Whether a `set_property` write actually changes a real plug's state —
  needs a real device to toggle.
- A real MFA challenge's shape — genuinely unobserved by anyone in this
  epic; the one real login relayed so far didn't trigger one.
- Whether a MINTED app identity (as opposed to the community SDK's static
  one) would be ACCEPTED by the device host — nobody has run this
  experiment; see `src/wyze-device-identity.ts`'s header comment for why
  "the static one works" does not answer this question either way.

If you have a real account and want to close one of the second list's
gaps: that is exactly the kind of measurement this document's own
existence argues for spending deliberately — state the falsification
criterion first (per step 1 above), change ONE thing at a time, and feed
the result back into a `PROVENANCE: CAPTURED-LIVE` (your own direct
observation) or `PROVENANCE: RELAYED` (someone else's, passed to you)
fixture, dated, per `src/transport-fake.ts`'s tagging convention — never
into an `ASSUMED` one you leave unmarked as still-a-guess.
