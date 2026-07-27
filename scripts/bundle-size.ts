/**
 * Assert a size budget on the built MCP App bundles and print the result as a
 * markdown table for $GITHUB_STEP_SUMMARY.
 *
 * The shot-graph app is served as the `ui://shot-graph/app.html` resource body
 * and re-sent on every render, so its weight is a per-render cost rather than a
 * one-off download. Vite's build settings are already right (production React,
 * minified, tree-shaken named recharts imports) — the weight is dependencies,
 * and nothing stopped a dependency bump from doubling it silently.
 *
 * Budgets are set with roughly 10% headroom over the measured size: enough that
 * ordinary dependency patches do not trip the gate, tight enough that a new
 * transitive chart or state library does. Raising one is a deliberate, reviewed
 * one-line diff — which is the point.
 *
 * Both axes are checked. Raw bytes are what the MCP host parses and what the
 * server holds in memory; gzip is what crosses the wire. A change can regress
 * one without the other.
 *
 * Usage:
 *   bun scripts/bundle-size.ts            # missing artifact -> notice, exit 0
 *   bun scripts/bundle-size.ts --strict   # missing artifact -> error, exit 1
 *
 * The default is lenient so `check:affected` does not fail when turbo
 * legitimately skipped the shot-graph build. CI passes --strict, having built
 * the bundle immediately beforehand, so there the artifact is never optional.
 */
import { existsSync, readFileSync } from "node:fs";

interface Budget {
  /** Path to the built artifact, relative to the repo root. */
  path: string;
  /** Ceiling on the on-disk bytes the host parses. */
  maxBytes: number;
  /** Ceiling on the transfer-encoded bytes. */
  maxGzipBytes: number;
}

const BUDGETS: Budget[] = [
  {
    path: "packages/shot-graph/dist/app.html",
    // 1,047,652 B raw / 279,233 B gzip measured 2026-07-27 (recharts 3.10.1).
    maxBytes: 1_150_000,
    maxGzipBytes: 310_000,
  },
];

const strict = process.argv.includes("--strict");

/** Decimal kB, matching the units Vite prints at build time. */
function kb(bytes: number): string {
  return `${(bytes / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} kB`;
}

/** How much of the budget is left, as a signed percentage of the budget. */
function headroom(bytes: number, max: number): string {
  const pct = ((max - bytes) / max) * 100;
  return `${pct >= 0 ? "" : "-"}${Math.abs(pct).toFixed(1)}%`;
}

interface Row {
  label: string;
  bytes: number;
  max: number;
  over: boolean;
}

const rows: Row[] = [];
const missing: string[] = [];

for (const budget of BUDGETS) {
  if (!existsSync(budget.path)) {
    missing.push(budget.path);
    continue;
  }
  const raw = readFileSync(budget.path);
  const gzip = Bun.gzipSync(raw);
  rows.push({
    label: `\`${budget.path}\``,
    bytes: raw.byteLength,
    max: budget.maxBytes,
    over: raw.byteLength > budget.maxBytes,
  });
  rows.push({
    label: "↳ gzip",
    bytes: gzip.byteLength,
    max: budget.maxGzipBytes,
    over: gzip.byteLength > budget.maxGzipBytes,
  });
}

console.log("## Bundle size");
console.log("");

if (rows.length > 0) {
  console.log("| Artifact | Size | Budget | Headroom |");
  console.log("| -------- | ---- | ------ | -------- |");
  for (const row of rows) {
    const status = row.over ? " **over budget**" : "";
    console.log(
      `| ${row.label} | ${kb(row.bytes)} | ${kb(row.max)} | ${headroom(row.bytes, row.max)}${status} |`,
    );
  }
}

for (const path of missing) {
  const note = `${path} not built — run \`bun run build\` before checking the size budget.`;
  console.log(rows.length > 0 ? `\n_${note}_` : `_${note}_`);
  // A GitHub annotation either way, so a skipped budget is never invisible.
  console.error(strict ? `::error::${note}` : `::notice::${note}`);
}

const breached = rows.filter((row) => row.over);
for (const row of breached) {
  console.error(
    `::error::${row.label.replaceAll("`", "")} is ${kb(row.bytes)}, over its ${kb(row.max)} budget. Trim the dependency that grew it, or raise the budget in scripts/bundle-size.ts with a note saying why.`,
  );
}

if (breached.length > 0 || (strict && missing.length > 0)) process.exit(1);
