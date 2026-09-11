// src/capture-format.ts: the paste-back redaction rule, the capture record
// template, and the worked provenance-fixture conversion.

import { describe, expect, test } from "bun:test";
import { evaluateWrongBoxGuard } from "../../src/cycle-wrong-box.ts";
import {
  ADDRESS_REDACTED,
  redactAddressesForPasteBack,
  renderCaptureForPasteBack,
  toProvenanceFixtureComment,
  type CaptureRecord,
} from "../../src/capture-format.ts";

describe("redactAddressesForPasteBack — required test: no address survives on the paste-back path", () => {
  test("named test: IPv4, IPv6 (compressed), and IPv4-mapped IPv6 — each in the SHAPE the wrong-box guard actually produces — are all scrubbed", () => {
    // Built from the REAL evaluateWrongBoxGuard() (src/cycle-wrong-box.ts),
    // not a hand-typed string shaped to make this test pass — this is the
    // exact prose `wyzr doctor --json`/`wyzr cycle --dry-run --json` emit
    // in their own wrongBoxGuard.reasons field. If evaluateWrongBoxGuard()'s
    // own wording ever changes shape, this test still constructs its input
    // from the real function, so it keeps testing the real emitted shape
    // rather than a frozen guess at it.
    const ipv4Case = evaluateWrongBoxGuard("fixture-target.invalid", ["203.0.113.5"], ["203.0.113.9"]);
    const ipv6CompressedCase = evaluateWrongBoxGuard("fixture-target.invalid", ["2001:db8::1"], ["2001:db8::1"]);
    const ipv4MappedCase = evaluateWrongBoxGuard("fixture-target.invalid", ["::ffff:203.0.113.5"], ["::ffff:203.0.113.5"]);

    for (const result of [ipv4Case, ipv6CompressedCase, ipv4MappedCase]) {
      const payload = JSON.stringify({ wrongBoxGuard: result });
      const pastedBack = redactAddressesForPasteBack(payload);
      expect(pastedBack).not.toContain("203.0.113.5");
      expect(pastedBack).not.toContain("203.0.113.9");
      expect(pastedBack).not.toContain("2001:db8::1");
      expect(pastedBack).not.toContain("::ffff:203.0.113.5");
      expect(pastedBack).toContain(ADDRESS_REDACTED);
    }
  });

  test("a fully-expanded (non-compressed) IPv6 address — the guard's own CANONICAL_IPV6_LOOPBACK shape — is also scrubbed", () => {
    const text = `resolves to 0:0:0:0:0:0:0:1 which is loopback`;
    const result = redactAddressesForPasteBack(text);
    expect(result).not.toContain("0:0:0:0:0:0:0:1");
    expect(result).toContain(ADDRESS_REDACTED);
  });

  test("ASSUMPTION CHECK — a test whose input contains no address in the guard's real format would prove nothing: confirm the fixture strings above are actually present before redaction, so this test could FAIL if redaction did nothing", () => {
    const result = evaluateWrongBoxGuard("fixture-target.invalid", ["203.0.113.5"], ["203.0.113.9"]);
    const raw = JSON.stringify(result);
    expect(raw).toContain("203.0.113.5");
    expect(raw).toContain("203.0.113.9");
  });
});

describe("redactAddressesForPasteBack — must not cripple ordinary paste-back content", () => {
  test("an ISO-8601 timestamp survives untouched — the epic's own ruling: redact addresses, not the rest of the diagnostics", () => {
    const text = "since=2026-09-11T15:26:26.144Z elapsedMs=4021";
    expect(redactAddressesForPasteBack(text)).toBe(text);
  });

  test("a hostname and a plug name (non-address identifiers) survive untouched — this module's own documented scope", () => {
    const text = 'target="fixture-suspect-box.invalid" plug="fixture-fleet-plug"';
    expect(redactAddressesForPasteBack(text)).toBe(text);
  });
});

describe("CaptureRecord / renderCaptureForPasteBack — expectation before result, comparable across runs", () => {
  function fixtureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
    return {
      expectedBeforeRun: "exit 0 and P3 decodes to a known on/off state",
      command: "wyzr plug status fixture-fleet-plug --json",
      startedAt: "2026-09-11T15:20:00.000Z",
      finishedAt: "2026-09-11T15:20:01.000Z",
      exitCode: 0,
      rawOutput: '{"power":"on","reachable":true}',
      verdict: "matches expectation",
      ...overrides,
    };
  }

  test("the expectation section renders BEFORE the result section — structurally, not just as a convention", () => {
    const rendered = renderCaptureForPasteBack(fixtureRecord());
    const expectationIndex = rendered.indexOf("Expectation (stated before running)");
    const resultIndex = rendered.indexOf("### Result");
    expect(expectationIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(expectationIndex);
  });

  test("two captures of the SAME check produce the same section headings in the same order — diffable across runs", () => {
    const first = renderCaptureForPasteBack(fixtureRecord());
    const second = renderCaptureForPasteBack(fixtureRecord({ finishedAt: "2026-09-12T09:00:01.000Z", verdict: "matches expectation" }));
    const headings = (s: string) => s.split("\n").filter((l) => l.startsWith("###"));
    expect(headings(first)).toEqual(headings(second));
  });

  test("the rendered block redacts addresses found in rawOutput", () => {
    const rendered = renderCaptureForPasteBack(
      fixtureRecord({ rawOutput: JSON.stringify({ reasons: ['resolves to 203.0.113.5, none of which match (203.0.113.9)'] }) }),
    );
    expect(rendered).not.toContain("203.0.113.5");
    expect(rendered).toContain(ADDRESS_REDACTED);
  });
});

describe("toProvenanceFixtureComment — worked example, end to end, from SYNTHETIC placeholder data", () => {
  test("produces a PROVENANCE: CAPTURED-LIVE tag with the date read straight off the record, matching src/transport-fake.ts's own tag format", () => {
    const record: CaptureRecord = {
      expectedBeforeRun: "exit 0, device_list contains exactly one entry with mac=FIXTURE-MAC-0000",
      command: "wyzr devices list --json",
      startedAt: "2026-09-11T15:00:00.000Z",
      finishedAt: "2026-09-11T15:00:02.000Z",
      exitCode: 0,
      rawOutput: '{"devices":[{"mac":"FIXTURE-MAC-0000","model":"WLPP1CFH"}]}',
      verdict: "matches expectation",
    };

    const comment = toProvenanceFixtureComment(record, "devices list, placeholder-credential probe");

    expect(comment).toContain("PROVENANCE: CAPTURED-LIVE");
    expect(comment).toContain("devices list, placeholder-credential probe");
    expect(comment).toContain("2026-09-11"); // the date, read directly off startedAt
    expect(comment).toContain(record.command);
    expect(comment).toContain(record.expectedBeforeRun);
    expect(comment).toContain("matches expectation");
  });

  test("does NOT redact addresses — a merged fixture needs the real shape it pins, a different surface from the paste-back path", () => {
    const record: CaptureRecord = {
      expectedBeforeRun: "fixture",
      command: "wyzr doctor --json",
      startedAt: "2026-09-11T15:00:00.000Z",
      finishedAt: "2026-09-11T15:00:02.000Z",
      exitCode: 0,
      rawOutput: '{"wrongBoxGuard":{"reasons":["resolves to 203.0.113.5"]}}',
      verdict: "matches expectation",
    };
    // toProvenanceFixtureComment() does not even read rawOutput today, but
    // this pins the deliberate design choice (stated in this module's own
    // doc comment) so a future change that starts including rawOutput
    // verbatim does not silently start redacting it by accident.
    const comment = toProvenanceFixtureComment(record, "fixture");
    expect(comment).not.toContain(ADDRESS_REDACTED);
  });
});
