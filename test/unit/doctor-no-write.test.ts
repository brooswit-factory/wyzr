// THE THIRD of three checks proving `wyzr doctor` cannot switch a plug —
// see test/unit/doctor-imports.test.ts's own top comment for what each of
// the three can and cannot see. This one is a plain source-level grep,
// blind to everything except literal call-site text: it would not catch a
// write reached through a renamed alias, reflection, or a dynamically
// constructed method name — but it WOULD catch the one thing neither the
// import-closure test nor the `PlugReader`-typing pin can: a stray
// `session.setProperty(...)` or `plug.writePower(...)` call typed against
// something OTHER than `PlugReader` (e.g. cast through `any`, or called on
// a concrete `RealCyclePlugTransport`/`WyzeAuthSession` reference the
// author forgot to narrow) landing in one of this command's own new files.
//
// Scoped to the doctor's own new files, not all of src/ — src/cycle-plug.ts
// and src/auth-session.ts legitimately DEFINE writePower()/setProperty();
// this test is about whether the DOCTOR's own code ever CALLS one, not
// whether the methods exist anywhere in the repo.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../../src");

const DOCTOR_OWN_FILES = ["doctor.ts", "doctor-plug.ts", "doctor-runner.ts", "cli-doctor.ts"];

const FORBIDDEN_CALL_SITES: readonly RegExp[] = [/\bwritePower\s*\(/, /\.setProperty\s*\(/];

describe("wyzr doctor's own new files — no write call site anywhere", () => {
  test("named test: none of doctor.ts/doctor-plug.ts/doctor-runner.ts/cli-doctor.ts contains a writePower( or .setProperty( call site", () => {
    let totalLines = 0;
    const violations: string[] = [];

    for (const name of DOCTOR_OWN_FILES) {
      const path = resolve(SRC_ROOT, name);
      const lines = readFileSync(path, "utf8").split("\n");
      totalLines += lines.length;
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Skip comment lines — this file's OWN top comment, and the other
        // doctor files' comments, mention `writePower(`/`.setProperty(` by
        // name in backtick-quoted prose to explain what this test looks
        // for; that prose is not a call site. A real call site is always
        // code, never a `//`/`*`-prefixed line.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        for (const pattern of FORBIDDEN_CALL_SITES) {
          if (pattern.test(line)) {
            violations.push(`${name}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    // Sanity floor: assert the scan actually read a meaningful amount of
    // source before trusting its silence — a floor on LINES scanned, per
    // the ticket's own "assert the expected sample size before a negative
    // is allowed to mean anything," the same discipline
    // test/unit/recovery-imports.test.ts applies to its own walk's
    // reached-module count.
    expect(totalLines).toBeGreaterThan(400);

    if (violations.length > 0) {
      throw new Error(`Forbidden write call site(s) found:\n${violations.join("\n")}`);
    }
  });
});
