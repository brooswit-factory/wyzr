// Proves "structurally incapable of switching a plug" the ONLY way that is
// actually true for `wyzr doctor`: it does NOT prove no plug/transport/auth
// module is reachable at all (test/unit/recovery-imports.test.ts's own
// property) — `wyzr doctor` must READ a plug, so it necessarily imports
// src/auth-session.ts, src/transport.ts/src/transport-http.ts, and
// src/cycle-plug.ts (for the `PlugReader` type and `RealCyclePlugTransport`,
// which DOES implement `writePower` — see src/doctor-plug.ts's own top
// comment for why that is fine: this command's own functions are typed to
// accept only `PlugReader`, never `PlugWriter`, which is a DIFFERENT
// property from "the module is unreachable," pinned separately by
// test/unit/doctor-plug.test.ts's `@ts-expect-error` mutation-tested pin).
//
// What THIS test proves instead: no import path exists from this command's
// entry point to any module that could ORCHESTRATE a real write —
// src/cli-plug.ts (whose `runPlugWrite()` is unconditionally reachable by
// importing that file at all), src/cycle-runner.ts (the power-cycle
// orchestrator), or src/cli-cycle.ts (which wires a live write path
// together). A closure walk that found the transport/auth layer present
// would prove nothing on its own — see src/doctor-plug.ts's own comment for
// what this test can and cannot see, and what the OTHER two checks
// (test/unit/doctor-plug.test.ts's typecheck pin, and
// test/unit/doctor-no-write.test.ts's source-level grep) catch instead.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../../src");

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

/** Same walk as test/unit/recovery-imports.test.ts's own importClosure() —
 * duplicated rather than shared, matching this repo's existing convention
 * of each import-closure test owning its own copy (recovery-imports.test.ts
 * has no shared test-support module to import this from either). */
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
      continue;
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

/** The orchestration modules that must be unreachable: each one either
 * unconditionally contains a write call (src/cli-plug.ts's `runPlugWrite`)
 * or exists specifically to wire a live write path together
 * (src/cycle-runner.ts, src/cli-cycle.ts, and — WYZR-30 — the write
 * rehearsal's own src/rehearsal-runner.ts/src/cli-rehearsal.ts). Does NOT
 * include src/cycle-plug.ts (which this command legitimately imports for
 * the `PlugReader` TYPE — see this file's own top comment), src/auth-session.ts,
 * or src/transport*.ts, all of which this command necessarily reaches to
 * perform its one real read.
 *
 * WYZR-30: watched failing first, per the ticket's own instruction — a
 * temporary `import "./rehearsal-runner.ts";` added to src/cli-doctor.ts
 * made this test fail with "src/rehearsal-runner.ts IS reachable from
 * src/cli-doctor.ts, via: ..." (captured in this PR's own body), then the
 * import was removed and this test re-confirmed green. */
const FORBIDDEN_MODULES = [
  resolve(SRC_ROOT, "cli-plug.ts"),
  resolve(SRC_ROOT, "cycle-runner.ts"),
  resolve(SRC_ROOT, "cli-cycle.ts"),
  resolve(SRC_ROOT, "rehearsal-runner.ts"),
  resolve(SRC_ROOT, "cli-rehearsal.ts"),
];

describe("src/cli-doctor.ts — no import path to a write-orchestrating module", () => {
  test("no import path exists from src/cli-doctor.ts to cli-plug.ts, cycle-runner.ts, or cli-cycle.ts", () => {
    const entry = resolve(SRC_ROOT, "cli-doctor.ts");
    const { reached, pathTo } = importClosure(entry);

    // Sanity floor: assert this walk actually reached a meaningful number
    // of this command's own real dependencies (including the transport/
    // auth layer it DOES legitimately need) before trusting its silence
    // about the forbidden ones — an empty/broken walk that "found nothing"
    // would otherwise pass this test for the wrong reason.
    expect(reached.size).toBeGreaterThan(15);
    expect(reached.has(resolve(SRC_ROOT, "auth-session.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "transport-http.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "cycle-plug.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "cycle-wrong-box.ts"))).toBe(true);
    expect(reached.has(resolve(SRC_ROOT, "config.ts"))).toBe(true);

    for (const forbidden of FORBIDDEN_MODULES) {
      if (reached.has(forbidden)) {
        const chain = pathTo.get(forbidden)!.join(" -> ");
        throw new Error(`${forbidden} IS reachable from src/cli-doctor.ts, via: ${chain}`);
      }
    }
  });

  test("src/doctor-runner.ts and src/doctor-plug.ts (the I/O layer) have no import path to those modules either", () => {
    for (const entryName of ["doctor-runner.ts", "doctor-plug.ts", "doctor.ts"]) {
      const { reached } = importClosure(resolve(SRC_ROOT, entryName));
      for (const forbidden of FORBIDDEN_MODULES) {
        expect(reached.has(forbidden)).toBe(false);
      }
    }
  });
});
