/**
 * Aggregate per-package vitest coverage into one markdown table.
 *
 * `.github/workflows/ci.yml`'s `check` job runs this as **Publish coverage
 * summary** (`:106-107`), appending to `$GITHUB_STEP_SUMMARY` after
 * `turbo run test:coverage`, on every PR against `main` and every push to
 * `main`. `check` is one of the three required status contexts
 * (`scripts/setup-branch-protection.sh`), so this output is on the path to
 * merge and a non-zero exit here fails the job — the step carries no `if:` and
 * no `continue-on-error`. The point is that coverage is visible at review time
 * without downloading artifacts.
 *
 * Packages without a coverage-summary.json (no tests, or coverage not run) are
 * simply absent from the table. The story smoke tests contribute a separate
 * render-path row from the root-level coverage-stories/ report, kept distinct
 * from the unit rows because it spans every packages/* source at once.
 *
 * ## The baseline diff is best-effort by construction
 *
 * When `coverage-baseline/` is present, every cell whose value *moved* is
 * annotated with its delta vs `main`, so a reviewer sees test-depth regressions
 * without diffing raw numbers; an unchanged metric stays a bare percentage. CI
 * restores the baseline from a cache before this runs (**Restore coverage
 * baseline**, `ci.yml:98-104`) and re-saves it after pushes to `main`
 * (`:113-130`).
 *
 * On a PR that restore is *designed* to miss its primary key. The key is
 * `coverage-baseline-` plus `github.sha`, and the only writer of it is the
 * push-to-`main`-gated save step using the same expression — so a PR, whose
 * `github.sha` is an ephemeral merge commit nobody ever saved, cannot hit it.
 * The bare `restore-keys: coverage-baseline-` prefix is what actually resolves,
 * and `actions/cache` answers a prefix with the most recently created matching
 * entry: the last `main` push's snapshot, which is exactly the baseline wanted.
 * The SHA stamp is there because cache entries are immutable and a fixed key
 * could never be updated. (The one case where the primary key does hit is a
 * re-run of a `main` push, which replays a SHA its own first attempt saved.)
 *
 * So a missing baseline is a normal state, not a failure, and nothing here
 * treats it as one: `readTotals` returns null, the optional chain in `row`
 * yields undefined, and `cell` prints a bare percentage. That happens on the
 * first `main` run and whenever the entry has been evicted. It is **not** what
 * happens on a fork PR — a fork can restore caches from the base branch, it
 * just cannot save one, and the save step is push-gated so it never would.
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
