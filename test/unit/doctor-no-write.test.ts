// THE THIRD of three checks proving `wyzr doctor` cannot switch a plug —
// see test/unit/doctor-imports.test.ts's own top comment for what each of
// the three can and cannot see. This one is a source-level grep for a
// `writePower(`/`.setProperty(` call site — blind to everything except
// literal call-site text (a renamed alias, reflection, or a dynamically
// constructed method name would all slip past it), but able to catch a
// stray write call reached through something OTHER than the typing pin or
// the import-closure walk's own three named modules.
//
// REVIEW FINDING (WYZR-20, this ticket): the scanned file set used to be a
// HARDCODED four-entry array (`doctor.ts`/`doctor-plug.ts`/
// `doctor-runner.ts`/`cli-doctor.ts`). Measured, not argued: adding ONE
// ordinary new module (`src/doctor-extra.ts`, exporting a function typed
// `PlugWriter` that calls `plug.writePower("0")`) and importing it from
// `src/doctor-runner.ts` passed typecheck AND every existing test —
// nothing caught it, because the typing pin is scoped to one function's
// signature, the import-closure walk (test/unit/doctor-imports.test.ts)
// only forbids three NAMED modules and has no opinion about a new
// first-party one, and this file's own old hardcoded array never opened a
// fifth file at all. The `totalLines > 400` floor still passed, because it
// sizes the (wrong) sample rather than checking the sample is the right
// one. Reproduced independently before this fix: attack applied, all three
// checks stayed green; attack reverted; fix below applied; attack
// re-applied, THIS test caught it (see the PR body for the exact
// before/after transcripts).
//
// THE FIX: derive the scanned set from the SAME import-closure walk
// test/unit/doctor-imports.test.ts already performs from `cli-doctor.ts`,
// rather than hand-naming files. This FAILS CLOSED — a new doctor-adjacent
// module is, by definition, now reachable from `cli-doctor.ts`, so it is
// automatically IN the scanned set with no one having to remember to add
// it. The only files excluded are `ALLOWLISTED_DEFINERS` below — modules
// that legitimately DEFINE `writePower()`/`setProperty()` as part of the
// read/write boundary this command legitimately depends on
// (`src/auth-session.ts`, `src/cycle-plug.ts`) — measured to be exactly
// two such files in the entire 31-module closure, both definers, zero
// unexplained call sites beyond them.
//
// WHAT THIS STILL CANNOT SEE, even after the fix: a write reached through
// a dynamic `import()`, a string-built specifier, an aliased or
// dynamically-constructed method name, or one hiding inside a module on
// `ALLOWLISTED_DEFINERS` for a reason OTHER than "it legitimately defines
// the write boundary" (there is no such entry today, but the allowlist
// itself is not re-derived — a human adding an unjustified exclusion there
// would not be caught by this test). None of these exist in this repo
// today; this is the honestly-disclosed residual gap, not the one the
// review found.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../../src");

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

/** Same walk as test/unit/doctor-imports.test.ts's own importClosure() —
 * duplicated rather than shared, matching this repo's existing convention
 * (test/unit/recovery-imports.test.ts's own copy predates both). */
function importClosure(entryPath: string): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [entryPath];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolve(dirname(file), match[1]!);
      if (!reached.has(resolved)) queue.push(resolved);
    }
  }

  return reached;
}

/** Modules that legitimately DEFINE `writePower()`/`setProperty()` as part
 * of the transport/plug boundary this command necessarily reaches to
 * perform its one real read — excluded from the scan for that reason, and
 * ONLY that reason. Measured (this ticket's review) to be the entire set:
 * of the 31 modules reachable from `cli-doctor.ts`, exactly these two
 * contain a `writePower(`/`.setProperty(` call site in non-comment code. */
const ALLOWLISTED_DEFINERS = [resolve(SRC_ROOT, "auth-session.ts"), resolve(SRC_ROOT, "cycle-plug.ts")];

const FORBIDDEN_CALL_SITES: readonly RegExp[] = [/\bwritePower\s*\(/, /\.setProperty\s*\(/];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("wyzr doctor's own dependency closure — no write call site anywhere outside the allowlisted definers", () => {
  test("named test: every module reachable from cli-doctor.ts, minus auth-session.ts/cycle-plug.ts, contains no writePower( or .setProperty( call site", () => {
    const entry = resolve(SRC_ROOT, "cli-doctor.ts");
    const reached = importClosure(entry);
    const scanned = [...reached].filter((f) => !ALLOWLISTED_DEFINERS.includes(f));

    // Sanity floor #1: the derivation actually reached this command's own
    // four files — a broken walk that "found nothing" would otherwise
    // scan an empty (or wrong) set and pass for the wrong reason. This is
    // exactly the review's own "assert the derived set actually contains
    // the four known doctor files" requirement.
    for (const name of ["doctor.ts", "doctor-plug.ts", "doctor-runner.ts", "cli-doctor.ts"]) {
      expect(scanned).toContain(resolve(SRC_ROOT, name));
    }

    // Sanity floor #2: a meaningful amount of source was actually read —
    // same discipline as the old hardcoded-array version's line-count
    // floor, now applied to the DERIVED set instead of a fixed list.
    let totalLines = 0;
    const violations: string[] = [];
    for (const file of scanned) {
      const lines = readFileSync(file, "utf8").split("\n");
      totalLines += lines.length;
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const pattern of FORBIDDEN_CALL_SITES) {
          if (pattern.test(line)) {
            violations.push(`${file.replace(SRC_ROOT + "/", "")}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(totalLines).toBeGreaterThan(400);

    if (violations.length > 0) {
      throw new Error(`Forbidden write call site(s) found:\n${violations.join("\n")}`);
    }
  });

  test("the allowlisted definers themselves DO contain a write call site — proving the allowlist is doing real exclusion work, not vacuously naming files with nothing in them", () => {
    for (const file of ALLOWLISTED_DEFINERS) {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => !isCommentLine(l));
      const hasWriteCallSite = lines.some((line) => FORBIDDEN_CALL_SITES.some((p) => p.test(line)));
      expect(hasWriteCallSite).toBe(true);
    }
  });
});
