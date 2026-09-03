// The password transform Wyze's login call expects: MD5 applied three
// times in a chain, `md5(md5(md5(password)))` — NOT a single MD5, NOT the
// raw password. docs/wyze-api-findings-2026-09-02.md §Q3 (tier (b), from
// `wyze_sdk/service/auth_service.py`) is explicit about the triple chain;
// get this wrong and every login attempt fails with the same errorCode
// 1000 as a genuinely wrong password (see wyze-errors.ts), with no way to
// tell the two apart from the response alone.
//
// MD5 is cryptographically broken for its original purposes, but that is
// irrelevant here: this project does not choose this hash, Wyze's own
// server-side login contract does, and wyzr must match it byte for byte to
// authenticate at all.

import { createHash } from "node:crypto";

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/** `md5(md5(md5(password)))`, hex-encoded at each step, per the finding. */
export function wyzeTripleMd5(password: string): string {
  return md5Hex(md5Hex(md5Hex(password)));
}
