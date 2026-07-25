/**
 * Aggregate per-package vitest coverage into one markdown table. Intended for
 * a future CI job to append to $GITHUB_STEP_SUMMARY after `turbo run
 * test:coverage`, so coverage is visible at review time without downloading
 * artifacts (there is no `.github/` in this repo yet, so nothing runs this
 * automatically today). Packages without a coverage-summary.json (no tests,
 * or coverage not run) are simply absent from the table. The story smoke
 * tests contribute a separate render-path row from the root-level
 * coverage-stories/ report, kept distinct from the unit rows because it spans
 * every packages/* source at once.
 *
 * When a baseline tree is present (a future CI could restore `main`'s
 * coverage into `coverage-baseline/` from a cache before this runs) each cell
 * is annotated with its delta vs `main`, so a reviewer sees test-depth
 * regressions without diffing raw numbers. Baseline is best-effort: with no
 * baseline present the table degrades to plain absolute numbers.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Metric {
  pct: number;
}
interface CoverageTotals {
  statements: Metric;
  branches: Metric;
  functions: Metric;
  lines: Metric;
}

const BASELINE_DIR = "coverage-baseline";

function readTotals(file: string): CoverageTotals | null {
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, "utf-8")) as { total: CoverageTotals })
    .total;
}

/** Render one metric cell: the current pct, plus a signed delta vs baseline
 * when a baseline exists and the value actually moved. */
function cell(current: number, baseline: number | undefined): string {
  if (baseline === undefined) return `${current}%`;
  const delta = Math.round((current - baseline) * 10) / 10;
  if (delta === 0) return `${current}%`;
  const sign = delta > 0 ? "+" : "-";
  return `${current}% (${sign}${Math.abs(delta)})`;
}

function row(
  label: string,
  current: CoverageTotals,
  baseline: CoverageTotals | null,
): string {
  const c = (k: keyof CoverageTotals) =>
    cell(current[k].pct, baseline?.[k]?.pct);
  return `| ${label} | ${c("statements")} | ${c("branches")} | ${c("functions")} | ${c("lines")} |`;
}

/** Every package/report that could carry a coverage-summary.json, as
 * (label, current-file, baseline-file) triples. */
function* reports(): Generator<[string, string, string]> {
  for (const root of ["apps", "packages"]) {
    for (const dir of readdirSync(root).sort()) {
      const rel = join(root, dir, "coverage", "coverage-summary.json");
      yield [`\`${root}/${dir}\``, rel, join(BASELINE_DIR, rel)];
    }
  }
  const storyRel = join("coverage-stories", "coverage-summary.json");
  yield [
    "_stories (render-path, all packages)_",
    storyRel,
    join(BASELINE_DIR, storyRel),
  ];
}

const rows: string[] = [];
let sawBaseline = false;
for (const [label, currentFile, baselineFile] of reports()) {
  const current = readTotals(currentFile);
  if (!current) continue;
  const baseline = readTotals(baselineFile);
  if (baseline) sawBaseline = true;
  rows.push(row(label, current, baseline));
}

console.log("## Test coverage");
console.log("");
if (sawBaseline) {
  console.log("Deltas (+/-) are vs the latest `main` baseline.");
  console.log("");
}
console.log("| Package | Statements | Branches | Functions | Lines |");
console.log("| ------- | ---------- | -------- | --------- | ----- |");
console.log(rows.join("\n") || "| _no coverage data found_ | – | – | – | – |");
