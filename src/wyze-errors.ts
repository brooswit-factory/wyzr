// Typed, actionable errors for the Wyze auth/session flow, built on
// src/errors.ts's CliError/ExitCode taxonomy. Kept in one place so the
// exact wording review checks for (see the errorCode-1000 message below)
// has one home instead of being inlined at each call site.

import { CliError, ExitCode } from "./errors.ts";
import { authErrorCode, authErrorDescription, authRequestId, type WyzeAuthEnvelope } from "./wyze-auth-envelope.ts";
import { normalizeCode, normalizeMsg, type WyzeEnvelope } from "./wyze-envelope.ts";

/**
 * errorCode 1000 — REWRITTEN by WYZR-15, and this is a REVERSAL of what
 * this project previously shipped, not just a rewording. The earlier
 * message named exactly TWO indistinguishable causes (wrong password;
 * SSO-only account) on the belief those were the only ones. That belief
 * was an UNDER-COUNT: WYZR-15's live-account measurement showed this
 * project's OWN login request was malformed (keyid/apikey sent in the
 * body instead of as headers — see src/transport.ts's LoginRequest doc
 * comment) and that THIS SAME errorCode 1000 is what a real, correct
 * account got back for it — i.e. "Wyze never saw the key at all" is a
 * THIRD, genuinely different cause behind the identical code. A message
 * that confidently named only two causes, when the true cause was wyzr's
 * own malformed request, would have sent an operator to change a password
 * that was never the problem — worse than no message at all.
 *
 * The SSO warning is NOT dropped (docs/wyze-api-findings-2026-09-02.md
 * §Q3/§Q7 documents it as real, and the provisioning action item it names
 * still stands) — this message simply stops overclaiming that it is one
 * of only two possibilities.
 */
export function wyzeInvalidCredentialsOrSsoOnlyError(): CliError {
  return new CliError(
    "Wyze login failed (errorCode 1000). Wyze returns this SAME code for more than one distinct cause, " +
      "and its response does not say which: (1) the email, password, keyId, or keySecret in " +
      "credentials.json is wrong; (2) this Wyze account has no Wyze-native password because it was " +
      "created via Google/Apple SSO, so there is nothing for the required password hash to hash; or " +
      "(3) a bug in wyzr itself sent a request Wyze could not read the login key from at all — a client " +
      "problem, not a credentials or account problem. To check (2): open the Wyze app -> Account -> " +
      "Security and look for \"Change Password.\" If it is not there, this account is SSO-only and needs " +
      "a Wyze-specific password set there before wyzr can log in. If it IS there, double-check " +
      "email/password/keyId/keySecret in credentials.json for (1). If both check out, this may be (3) — " +
      "please report it, since it likely means a bug in wyzr's own request, not something wrong on your end.",
    ExitCode.CredentialsInvalid,
    "wyze_login_invalid_or_sso_only",
  );
}

/** A TOTP challenge was issued but credentials.json has no totpSecret
 * configured (or it was an empty string, treated as absent). */
export function wyzeMfaTotpSecretMissingError(): CliError {
  return new CliError(
    "Wyze requires a TOTP (authenticator app) code to finish logging in, but credentials.json has no " +
      "totpSecret configured. Add the account's TOTP secret to credentials.json's \"totpSecret\" field and retry.",
    ExitCode.MfaRequired,
    "mfa_totp_secret_missing",
  );
}

/** The configured totpSecret is not valid base32 and a code could not be computed. */
export function wyzeMfaTotpSecretInvalidError(cause: unknown): CliError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CliError(
    `credentials.json's totpSecret could not be used to compute a TOTP code: ${detail}. It must be the ` +
      "base32 secret an authenticator app would use, not a 6-digit code or anything else.",
    ExitCode.MfaRequired,
    "mfa_totp_secret_invalid",
  );
}

/** An SMS challenge was issued. wyzr has no way to receive or answer it. */
export function wyzeMfaSmsUnsupportedError(): CliError {
  return new CliError(
    "Wyze requires an SMS code to finish logging in, and wyzr cannot receive or answer an SMS challenge " +
      "automatically. Switch this account's MFA method to an authenticator app (TOTP) in the Wyze app, " +
      "configure the resulting secret in credentials.json's \"totpSecret\" field, and retry.",
    ExitCode.MfaRequired,
    "mfa_sms_unsupported",
  );
}

/** A challenge was detected but its type could not be classified as TOTP or SMS. */
export function wyzeMfaUnknownTypeError(): CliError {
  return new CliError(
    "Wyze issued a multi-factor challenge wyzr does not recognize (neither TOTP nor SMS). wyzr cannot " +
      "answer it automatically.",
    ExitCode.MfaRequired,
    "mfa_unknown_type",
  );
}

/** Login/refresh succeeded per `code`, but `data` did not actually carry
 * both tokens — a malformed response, not a normal branch. */
export function wyzeMalformedSuccessError(cause: unknown): CliError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CliError(
    `Wyze reported success but the response was malformed: ${detail}`,
    ExitCode.ApiError,
    "wyze_malformed_success_response",
  );
}

/** No refresh token is held (login has not succeeded yet) but a refresh was attempted. */
export function wyzeRefreshWithoutLoginError(): CliError {
  return new CliError(
    "Cannot refresh the Wyze access token: no refresh token is held. Call login() first.",
    ExitCode.Generic,
    "wyze_refresh_without_login",
  );
}

/** The refresh call itself failed. Surfaced as an error, never retried
 * automatically and never falls back to re-running the password login —
 * see the ticket's "authenticate once, hold and refresh, never re-login
 * per call" discipline. */
export function wyzeRefreshFailedError(envelope: WyzeEnvelope): CliError {
  return new CliError(
    `Wyze refresh_token call failed (code ${normalizeCode(envelope.code)}` +
      (normalizeMsg(envelope.msg) ? `, msg "${normalizeMsg(envelope.msg)}"` : "") +
      "). The held refresh token may itself be expired or invalid; a fresh login() is required.",
    ExitCode.ApiError,
    "wyze_refresh_failed",
  );
}

/** No access token is held (login has not succeeded yet) but an
 * authenticated call was attempted. */
export function wyzeNotAuthenticatedError(): CliError {
  return new CliError(
    "Cannot make an authenticated Wyze API call: no access token is held. Call login() first.",
    ExitCode.Generic,
    "wyze_not_authenticated",
  );
}

/** The access token expired again immediately after a refresh-and-retry.
 * Bounds the retry to exactly one attempt — see the ticket's requirement
 * to guard refresh-and-retry against infinite recursion. */
export function wyzeAccessTokenRefreshLoopError(): CliError {
  return new CliError(
    "Wyze reported the access token as expired again immediately after refreshing it. Refusing to retry " +
      "again (this would otherwise loop indefinitely).",
    ExitCode.ApiError,
    "wyze_access_token_refresh_loop",
  );
}

/** Any other non-success envelope not covered by a more specific error
 * above. Deliberately omits `data` from the message — never print a raw
 * API response wholesale, per the ticket. */
export function wyzeGenericApiError(envelope: WyzeEnvelope): CliError {
  const code = normalizeCode(envelope.code);
  const msg = normalizeMsg(envelope.msg);
  return new CliError(
    `Wyze API returned an error (code ${code}${msg ? `, msg "${msg}"` : ""}).`,
    ExitCode.ApiError,
    `wyze_api_error_${code}`,
  );
}

/** The AUTH-host counterpart of wyzeGenericApiError() above — any
 * auth-host response not covered by a more specific error (i.e. not
 * routed to wyzeInvalidCredentialsOrSsoOnlyError() via
 * isAuthInvalidCredentialsCode()). Reads the auth host's own
 * errorCode/description/requestId fields (src/wyze-auth-envelope.ts),
 * never `envelope.raw` wholesale — "report position, never content," per
 * the ticket. `requestId` is server-generated, not derived from anything
 * in the request body, so it is safe to surface as a support-trail
 * correlation id (the device host's equivalent field is `traceId` — see
 * the ticket's structural fact 2 — decoding that stays wyzeGenericApiError()'s
 * job, not this one's). */
export function wyzeGenericAuthApiError(envelope: WyzeAuthEnvelope): CliError {
  const code = authErrorCode(envelope);
  const description = authErrorDescription(envelope);
  const requestId = authRequestId(envelope);
  const detail = [description && `"${description}"`, requestId && `requestId ${requestId}`]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  return new CliError(
    `Wyze auth API returned an error (errorCode ${code}${detail ? `, ${detail}` : ""}).`,
    ExitCode.ApiError,
    `wyze_auth_api_error_${code}`,
  );
}
