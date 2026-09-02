// Verifies this module against two independent published standards, not
// against itself: RFC 6238 Appendix B's own worked TOTP examples, and
// RFC 4648 §10's own worked base32 examples. Nothing here needs a Wyze
// account, a network, or a credential of any kind.

import { describe, expect, test } from "bun:test";
import { base32Decode, hotp, totp, totpFromBase32Secret } from "../../src/totp.ts";

// RFC 6238 Appendix B's fixed 20-byte SHA-1 test key: the ASCII string
// "12345678901234567890". The RFC's own worked examples use 8-digit codes
// (Digit=8), not this module's 6-digit default — passed explicitly below.
const RFC6238_SHA1_KEY = Buffer.from("12345678901234567890", "ascii");

describe("totp — RFC 6238 Appendix B test vectors (SHA-1, 8 digits, 30s step)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [timeSeconds, expected] of vectors) {
    test(`T=${timeSeconds} -> ${expected}`, () => {
      expect(totp(RFC6238_SHA1_KEY, timeSeconds, { digits: 8, period: 30 })).toBe(expected);
    });
  }
});

describe("totp — digit truncation matches RFC dynamic truncation semantics", () => {
  // X mod 10^6 == (X mod 10^8) mod 10^6 for any integer X, because 10^8 is
  // a multiple of 10^6 — so the correct 6-digit code is exactly the last 6
  // characters of the RFC's own published 8-digit code at the same
  // counter. This is a derived consequence of the RFC vector above, not a
  // separately memorized "6-digit" magic number.
  test("6-digit output is the last 6 digits of the RFC's 8-digit vector at T=59", () => {
    expect(totp(RFC6238_SHA1_KEY, 59, { digits: 6, period: 30 })).toBe("287082");
  });

  test("default digits is 6", () => {
    expect(totp(RFC6238_SHA1_KEY, 59, { period: 30 })).toBe("287082");
  });

  test("default period is 30", () => {
    // T=59 and T=60 both floor to different counters at period 30 (1 vs 2)
    // than they would at some other period, so this also pins the default.
    expect(totp(RFC6238_SHA1_KEY, 59)).toBe(totp(RFC6238_SHA1_KEY, 59, { period: 30 }));
  });
});

describe("hotp — counter-driven, not time-driven", () => {
  test("matches totp() at the equivalent counter for the RFC T=59 vector", () => {
    // T = floor(59 / 30) = 1
    expect(hotp(RFC6238_SHA1_KEY, 1n, 8)).toBe("94287082");
  });

  test("different counters produce different codes", () => {
    expect(hotp(RFC6238_SHA1_KEY, 1n)).not.toBe(hotp(RFC6238_SHA1_KEY, 2n));
  });
});

describe("base32Decode — RFC 4648 §10 test vectors", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["MY======", "f"],
    ["MZXQ====", "fo"],
    ["MZXW6===", "foo"],
    ["MZXW6YQ=", "foob"],
    ["MZXW6YTB", "fooba"],
    ["MZXW6YTBOI======", "foobar"],
  ];

  for (const [encoded, expected] of vectors) {
    test(`decodes "${encoded}" to "${expected}"`, () => {
      expect(base32Decode(encoded).toString("ascii")).toBe(expected);
    });
  }

  test("is case-insensitive", () => {
    expect(base32Decode("mzxw6ytboi======").toString("ascii")).toBe("foobar");
  });

  test("tolerates missing padding and surrounding whitespace", () => {
    expect(base32Decode(" mzxw6ytb \n").toString("ascii")).toBe("fooba");
  });

  test("rejects an invalid base32 character", () => {
    expect(() => base32Decode("not-base32!")).toThrow();
  });
});

describe("totpFromBase32Secret — full pipeline over a user-facing secret", () => {
  // Base32 encoding of the RFC 6238 20-byte SHA-1 key above (computed once
  // and round-tripped through this module's own base32Decode to confirm it
  // decodes back to exactly the RFC's ASCII test key before trusting it as
  // a fixture — see the PR body for how this was checked).
  const RFC6238_SHA1_KEY_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("the base32 fixture decodes back to the RFC's own ASCII test key", () => {
    expect(base32Decode(RFC6238_SHA1_KEY_BASE32).toString("ascii")).toBe("12345678901234567890");
  });

  test("matches the RFC vector at T=59 when fed as a base32 secret", () => {
    expect(totpFromBase32Secret(RFC6238_SHA1_KEY_BASE32, 59, { digits: 8, period: 30 })).toBe("94287082");
  });
});
