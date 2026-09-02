// wyzr's own static, non-user-specific "app identity" value, sent as the
// `x-api-key` header on every Wyze API call (see
// docs/wyze-api-findings-2026-09-02.md §Q3): a fixed value the
// reverse-engineered API expects to identify the calling app/library,
// distinct from the user's own keyId/keySecret pair (which identifies the
// *user*, not the app, and comes from src/credentials.ts).
//
// The finding deliberately declined to reproduce the community SDK's own
// embedded value, and this project's ticket forbids copying it out of
// another project's source (fragile, and not ours to reuse). Instead we
// MINT OUR OWN: a SHA-256 hex digest of a fixed, versioned, wholly-public
// seed string naming this project — not derived from, resembling, or
// related to any other project's key in any way.
//
// Whether Wyze's API accepts a value it never issued is UNVERIFIED — the
// finding is explicit (tier (d)) that it could not check this without an
// authenticated call, which is out of scope for this project. Treat "our
// key is accepted" as an untested hope, not a working assumption.

import { createHash } from "node:crypto";

/** The seed this project's app-identity key is derived from. Versioned so
 * a future correction can mint APP_IDENTITY_KEY_V2 without disturbing this
 * one, if evidence ever shows this value is rejected. */
export const APP_IDENTITY_SEED = "wyzr-app-identity-key-v1" as const;

/** SHA-256 hex digest of APP_IDENTITY_SEED — see module comment above. */
export const APP_IDENTITY_KEY: string = createHash("sha256").update(APP_IDENTITY_SEED, "utf8").digest("hex");
