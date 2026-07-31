/**
 * Raise `apps/server`'s coverage thresholds to match what the last
 * `test:coverage` run actually measured, floored to one decimal place.
 *
 * This replaces vitest's own `coverage.thresholds.autoUpdate`, which wrote the
 * measured percentage back at full precision. That made the thresholds
 * monotonically increasing *within an uncommitted working tree*: a run would
 * write `lines: 98.1`, the next edit would move a single line out of the
 * covered set, and the re-run failed against a number nobody had committed —
 * reporting it as "you reduced coverage" when the fix was to discard a
 * generated file. Flooring to a tenth gives the ratchet a step large enough
 * that ordinary edits move within it rather than through it.
 *
 * Three properties are the point, and they are what #89 asks for:
 *
 * - **Idempotent.** Two runs on an unchanged tree write once at most — the
 *   floored value is already the committed one the second time.
 * - **Only ever raises.** A dip within the current step is absorbed; a real
 *   regression still fails, because vitest checks the committed threshold.
 * - **Local only.** CI calls `turbo run test:coverage` directly and never this
 *   script, so a CI run cannot mutate the config it is checking against.
 *
 * Invoked by the root `test:coverage` script, after turbo has run the suites.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG = "apps/server/vitest.config.ts";
const SUMMARY = "apps/server/coverage/coverage-summary.json";

const METRICS = ["branches", "functions", "lines", "statements"] as const;
type Metric = (typeof METRICS)[number];

/**
 * Floor to a tenth of a point. Rounding *down* rather than to nearest matters:
 * a threshold above the measured value fails the very run that wrote it.
 */
function floorToTenth(pct: number): number {
  return Math.floor(pct * 10) / 10;
}

if (!existsSync(SUMMARY)) {
  console.log(`coverage-ratchet: no ${SUMMARY}; run test:coverage first`);
  process.exit(0);
}

const measured = (
  JSON.parse(readFileSync(SUMMARY, "utf-8")) as {
    total: Record<Metric, { pct: number }>;
  }
).total;

const source = readFileSync(CONFIG, "utf-8");
const start = source.indexOf("thresholds: {");
const end = source.indexOf("}", start);
if (start === -1 || end === -1) {
  throw new Error(`${CONFIG} has no coverage.thresholds block to ratchet`);
}

let block = source.slice(start, end);
const raised: string[] = [];

for (const metric of METRICS) {
  const pattern = new RegExp(`(${metric}:\\s*)(\\d+(?:\\.\\d+)?)`);
  const match = block.match(pattern);
  if (!match?.[2]) {
    throw new Error(`${CONFIG} declares no ${metric} threshold`);
  }
  const current = Number(match[2]);
  const next = floorToTenth(measured[metric].pct);
  if (next <= current) continue;
  block = block.replace(pattern, `$1${next}`);
  raised.push(`${metric} ${current} → ${next}`);
}

if (raised.length === 0) {
  console.log("coverage-ratchet: thresholds already match measured coverage");
  process.exit(0);
}

writeFileSync(CONFIG, source.slice(0, start) + block + source.slice(end));
console.log(`coverage-ratchet: raised ${raised.join(", ")}`);
console.log(`coverage-ratchet: commit the new numbers in ${CONFIG}`);
