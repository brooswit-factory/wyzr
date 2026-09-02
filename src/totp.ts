// RFC 4226 HOTP and RFC 6238 TOTP, implemented against Node's standard
// `node:crypto` only — no third-party OTP package. Verified offline
// against RFC 6238 Appendix B's own published test vectors
// (test/unit/totp.test.ts) — per the ticket, one of the few pieces of this
// story provably correct rather than merely believed, because it can be
// checked against a published standard without any Wyze account at all.
//
// Wyze's own TOTP parameters (digit count, time step, hash algorithm) are
// NOT documented anywhere docs/wyze-api-findings-2026-09-02.md could
// confirm — the finding establishes only that a TOTP challenge can occur
// (tier (b)), not its parameters. The defaults below (6 digits, 30s period,
// SHA-1) are the near-universal authenticator-app convention; using them is
// this module's own reasoned default (tier (d), this author's inference),
// not a confirmed Wyze-specific fact. If a real account ever proves
// otherwise, only DEFAULT_DIGITS/DEFAULT_PERIOD below should need to change.

import { createHmac } from "node:crypto";

export interface TotpOptions {
  digits?: number;
  period?: number;
}

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

/** RFC 4226 HOTP over a raw (already-decoded) key and integer counter. */
export function hotp(key: Buffer, counter: bigint, digits: number = DEFAULT_DIGITS): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();

  const lastByte = hmac[hmac.length - 1];
  if (lastByte === undefined) {
    throw new Error("HMAC-SHA1 digest was unexpectedly empty");
  }
  const offset = lastByte & 0x0f;
  const b0 = hmac[offset];
  const b1 = hmac[offset + 1];
  const b2 = hmac[offset + 2];
  const b3 = hmac[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error("HMAC-SHA1 digest was shorter than the dynamic-truncation offset requires");
  }
  const binCode = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);

  const str = String(binCode % 10 ** digits);
  return str.padStart(digits, "0");
}

/** RFC 6238 TOTP: HOTP with counter = floor(timeSeconds / period), over a
 * raw (already-decoded) key. `timeSeconds` is Unix time in SECONDS. */
export function totp(key: Buffer, timeSeconds: number, opts: TotpOptions = {}): string {
  const period = opts.period ?? DEFAULT_PERIOD;
  const counter = BigInt(Math.floor(timeSeconds / period));
  return hotp(key, counter, opts.digits ?? DEFAULT_DIGITS);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes an RFC 4648 base32 string — the conventional encoding for a
 * user-facing TOTP secret (what an authenticator app's QR code / manual-
 * entry key carries) — into raw bytes. Case-insensitive; ignores `=`
 * padding and whitespace.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s]/g, "");
  let bits = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]!;
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      // Deliberately does NOT include `char` itself: this function is used
      // to decode a user-facing TOTP secret (see wyze-errors.ts's
      // wyzeMfaTotpSecretInvalidError), which can be user input typed or
      // pasted by mistake (e.g. a password pasted into the wrong field).
      // The redaction registry matches whole registered strings, not a
      // single unregistered character of one — so echoing the character
      // itself here would leak a fragment of a secret straight past
      // redaction. Position is metadata, not content.
      throw new Error(`Invalid base32 character at position ${i} of the input string`);
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** TOTP over a user-facing base32-encoded secret — the shape
 * `Credentials.totpSecret` (src/credentials.ts) carries. */
export function totpFromBase32Secret(secret: string, timeSeconds: number, opts: TotpOptions = {}): string {
  return totp(base32Decode(secret), timeSeconds, opts);
}
