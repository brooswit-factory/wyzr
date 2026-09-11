// Ships the REAL test the ticket demands for "structurally incapable of
// switching a plug": a comment asserting a property is not a test (the
// wedge trio's own README section states its own read-only property this
// way, checkable only by a human reading imports); this walks
// src/cli-recovery.ts's TRANSITIVE IMPORT CLOSURE and asserts none of the
// plug/transport/auth modules is reachable from it AT ALL — not just "no
// write verb is called," but no IMPORT PATH exists to reach one, which is
// what makes it a compile-time/build-time property rather than a runtime
// promise someone could quietly break.
//
// WATCHED RED FIRST, per the ticket's explicit instruction: a temporary
// `import "./plug.ts";` was added to the top of src/cli-recovery.ts,
// this test was run and OBSERVED TO FAIL (reported: "src/plug.ts IS
// reachable from src/cli-recovery.ts, via: src/cli-recovery.ts -> src/plug.ts"),
// then the import was removed and this test was re-run and observed to
// pass — see the PR description for the exact failing output captured.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../../src");

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

/** Walks the transitive import closure of `entryPath` (relative-import
 * edges only — this repo's own modules never import a write verb through
 * anything but a relative specifier) and returns the full set of resolved
 * module paths reachable from it, plus one example path (a chain of
 * specifiers) to each, for a legible failure message. */
function importClosure(entryPath: string): { reached: Set<string>; pathTo: Map<string, string[]> } {
  const reached = new Set<string>();
  const pathTo = new Map<string, string[]>();
  const queue: { file: string; chain: string[] }[] = [{ file: entryPath, chain: [entryPath] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    pathTo.set(file, chain);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // Not a file this repo owns (or already visited) — nothing further to walk.
    }

    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1]!;
      const resolved = resolve(dirname(file), specifier);
      if (!reached.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }

  return { reached, pathTo };
}

/** Every module this command must have NO import path to at all — the
 * plug/transport/auth surface, per the ticket's absolute rule and the
 * wedge trio's own precedent ("structurally read-only, not by
 * convention"). */
const FORBIDDEN_MODULES = [
  resolve(SRC_ROOT, "plug.ts"),
  resolve(SRC_ROOT, "cli-plug.ts"),
  resolve(SRC_ROOT, "auth-session.ts"),
  resolve(SRC_ROOT, "transport.ts"),
  resolve(SRC_ROOT, "transport-http.ts"),
  resolve(SRC_ROOT, "transport-fake.ts"),
];

describe("src/cli-recovery.ts — structurally incapable of switching a plug", () => {
  test("no import path exists from src/cli-recovery.ts to any plug/transport/auth module", () => {
    const entry = resolve(SRC_ROOT, "cli-recovery.ts");
    const { reached, pathTo } = importClosure(entry);

    // Sanity floor: assert this walk actually reached a meaningful number
    // of this command's own real dependencies before trusting its silence
    // about the forbidden ones — an empty/broken walk that "found nothing"
    // would otherwise pass this test for the wrong reason (the ticket's own
    // "assert the expected sample size before a negative result means
    // anything" rule, applied to a structural check instead of a sample).
    expect(reached.size).toBeGreaterThan(8);
    expect(reached.has(resolve(SRC_ROOT, "recovery.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "recovery-runner.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "wedge-probes.ts"))).toBe(true);

    for (const forbidden of FORBIDDEN_MODULES) {
      if (reached.has(forbidden)) {
        const chain = pathTo.get(forbidden)!.join(" -> ");
        throw new Error(`${forbidden} IS reachable from src/cli-recovery.ts, via: ${chain}`);
      }
    }
  });

  test("src/recovery.ts (the pure engine) itself has no import path to those modules either", () => {
    const entry = resolve(SRC_ROOT, "recovery.ts");
    const { reached } = importClosure(entry);
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(reached.has(forbidden)).toBe(false);
    }
  });
});
