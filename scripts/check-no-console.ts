#!/usr/bin/env bun
// CI gate: fails when anything under src/ writes to a std stream outside
// src/output.ts, the one module allowed to. See README.md for the
// equivalent grep a reviewer can paste by hand. This script is what CI
// actually runs — the README's grep is documentation of the same rule, not
// the enforcement.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
const EXEMPT = new Set(["output.ts"]);

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "console.*", pattern: /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/ },
  { name: "process.stdout/stderr.write", pattern: /\bprocess\.(stdout|stderr)\.write\s*\(/ },
  {
    name: "Bun.write(std stream)",
    pattern: /\bBun\.write\s*\(\s*(process\.(stdout|stderr)|Bun\.(stdout|stderr))/,
  },
];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat();
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const files = await collectTsFiles(SRC_DIR);
const contents = await Promise.all(files.map((file) => Bun.file(file).text()));

const violations: Violation[] = [];

files.forEach((file, fileIndex) => {
  const rel = relative(SRC_DIR, file);
  if (EXEMPT.has(rel)) return;

  const lines = contents[fileIndex]!.split("\n");
  lines.forEach((line, index) => {
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push({ file: `src/${rel}`, line: index + 1, rule: name, text: line.trim() });
      }
    }
  });
});

if (violations.length > 0) {
  console.error("Direct terminal writes found outside src/output.ts:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
  }
  console.error(
    "\nRoute all output through src/output.ts (printHuman/printJson/printError/printJsonError) so it cannot bypass redaction.",
  );
  process.exit(1);
}

console.log("No direct terminal writes outside src/output.ts.");
