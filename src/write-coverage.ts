/**
 * Single source of truth for the real-device write-coverage gap.
 *
 * PROVENANCE: RELAYED, operator, WYZR root-doc measurements through
 * 2026-09-11. Read paths were exercised, but no raw write capture exists.
 * A later real-device rehearsal must update this one constant.
 */
export const REAL_DEVICE_WRITE_NOTICE =
  "WARNING: Writes have never been exercised through wyzr against a real device (as of 2026-09-11). Evidence: WYZR root doc.";
