/**
 * Summarise a knip JSON report as a compact markdown table for the CI job
 * summary. Knip's `//#knip` turbo task is the hard gate (a green build already
 * means zero dead code); this is the informational readout beside it, so a
 * reviewer sees the category breakdown — and, if the gate is ever relaxed,
 * real counts — without opening the raw log.
 *
 * Input is `knip --reporter json` on stdin or a path arg: `{ issues: [{ file,
 * exports: [...], types: [...], files: [...], dependencies: [...], ... }] }`,
 * one row per file with an array per issue category.
 */
import { readFileSync } from "node:fs";

// Non-category keys knip attaches to each row.
const META_KEYS = new Set(["file", "owners"]);

// Friendlier labels for the categories worth naming; anything else falls back
// to its raw key.
const LABELS: Record<string, string> = {
  files: "Unused files",
  exports: "Unused exports",
  types: "Unused types",
  nsExports: "Unused exports in namespace",
  nsTypes: "Unused types in namespace",
  enumMembers: "Unused enum members",
  duplicates: "Duplicate exports",
  dependencies: "Unused dependencies",
  devDependencies: "Unused devDependencies",
  optionalPeerDependencies: "Unused optional peer dependencies",
  unlisted: "Unlisted dependencies",
  binaries: "Unlisted binaries",
  unresolved: "Unresolved imports",
  cycles: "Import cycles",
};

interface KnipRow {
  file?: string;
  [category: string]: unknown;
}

const path = process.argv[2];
const raw = path ? readFileSync(path, "utf-8") : readFileSync(0, "utf-8");

let issues: KnipRow[];
try {
  issues = (JSON.parse(raw) as { issues?: KnipRow[] }).issues ?? [];
} catch {
  console.log("## Dead-code (knip)");
  console.log("");
  console.log("_knip report unavailable_");
  process.exit(0);
}

const counts = new Map<string, number>();
for (const row of issues) {
  for (const [key, value] of Object.entries(row)) {
    if (META_KEYS.has(key) || !Array.isArray(value)) continue;
    counts.set(key, (counts.get(key) ?? 0) + value.length);
  }
}

const nonZero = [...counts.entries()]
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]);
const total = nonZero.reduce((sum, [, n]) => sum + n, 0);

console.log("## Dead-code (knip)");
console.log("");
if (total === 0) {
  console.log("No dead code, unused dependencies, or duplicate exports.");
} else {
  console.log(
    `${total} issue${total === 1 ? "" : "s"} across ${issues.length} file${issues.length === 1 ? "" : "s"}.`,
  );
  console.log("");
  console.log("| Category | Count |");
  console.log("| -------- | ----- |");
  for (const [key, n] of nonZero) {
    console.log(`| ${LABELS[key] ?? key} | ${n} |`);
  }
}
