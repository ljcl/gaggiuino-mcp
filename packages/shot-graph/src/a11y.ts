import { METRICS } from "./constants";
import {
  type Annotation,
  type ChartDataPoint,
  type PhaseRegion,
  type ShotMeta,
} from "./types";

/**
 * The chart's accessible name and description.
 *
 * A line chart is invisible to a screen reader: the SVG is a pile of paths
 * with no text. What a sighted user takes from this chart is the shape — where
 * pressure peaked, how long the shot ran, how it compares to the last one — so
 * that is what the description says, rather than reading coordinates aloud.
 *
 * Kept as a pure function so it is unit-testable without a browser, and so the
 * same sentences can be reused anywhere else the chart needs narrating.
 */

export interface ChartDescriptionInput {
  primary: ShotMeta;
  comparison?: ShotMeta;
  data: ChartDataPoint[];
  annotations?: Annotation[];
  /** Series keys the user has toggled off; they are named as hidden. */
  hidden?: ReadonlySet<string>;
  /** Profile phases, so the narration can say where the shot changed gear. */
  phases?: PhaseRegion[];
}

export interface ChartDescription {
  /** Short accessible name for the chart region. */
  title: string;
  /** The longer narration, referenced by aria-describedby. */
  desc: string;
}

function round(value: number, places = 1): string {
  return value.toFixed(places).replace(/\.0$/, "");
}

/** Highest value a series reaches, with the time it got there. */
function peakOf(
  data: ChartDataPoint[],
  key: keyof ChartDataPoint,
): { value: number; time: number } | null {
  let best: { value: number; time: number } | null = null;
  for (const point of data) {
    const value = point[key];
    if (typeof value !== "number") continue;
    if (!best || value > best.value) best = { time: point.time, value };
  }
  return best;
}

/** "a, b and c" — an Oxford-comma-free list, read aloud rather than scanned. */
function joinPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function describeChart({
  annotations,
  comparison,
  data,
  hidden,
  phases,
  primary,
}: ChartDescriptionInput): ChartDescription {
  const title = comparison
    ? `Espresso shot graph: ${primary.profileName} compared with ${comparison.profileName}`
    : `Espresso shot graph: ${primary.profileName}`;

  const sentences: string[] = [];

  const visible = METRICS.filter((m) => !hidden?.has(m.key));
  const hiddenMetrics = METRICS.filter((m) => hidden?.has(m.key));

  // Named from what is plotted rather than from a fixed list: temperature is
  // off until asked for, and a sentence that promised it either way would be
  // wrong half the time.
  const plotted = joinPhrase(visible.map((m) => m.label.toLowerCase()));
  sentences.push(
    `Line chart of ${plotted || "no series"} over ` +
      `${round(primary.duration)} seconds of a ${primary.profileName} shot ` +
      `yielding ${round(primary.weight)} grams.`,
  );

  if (phases && phases.length > 0) {
    sentences.push(
      `Profile phases: ${phases
        .map(
          (p) =>
            `${p.label.toLowerCase()} from ${round(p.start, 0)} to ${round(p.end, 0)} seconds`,
        )
        .join("; ")}.`,
    );
  }

  const peaks = visible
    .map((metric) => {
      const peak = peakOf(data, metric.key);
      return peak
        ? `${metric.label.toLowerCase()} ${round(peak.value)} ${metric.unit} ` +
            `at ${round(peak.time, 0)} seconds`
        : null;
    })
    .filter((s): s is string => s !== null);
  if (peaks.length > 0) sentences.push(`Peak values: ${peaks.join("; ")}.`);

  if (annotations && annotations.length > 0) {
    sentences.push(
      `Marked points: ${annotations.map((a) => a.label).join(", ")}.`,
    );
  }

  if (comparison) {
    const delta = primary.weight - comparison.weight;
    const timeDelta = primary.duration - comparison.duration;
    sentences.push(
      `Compared with ${comparison.profileName} (${round(comparison.weight)} grams in ` +
        `${round(comparison.duration)} seconds): ${describeDelta(delta, "grams")} and ` +
        `${describeDelta(timeDelta, "seconds")}.`,
    );
  }

  if (hiddenMetrics.length > 0) {
    sentences.push(
      `${hiddenMetrics.map((m) => m.label).join(" and ")} ` +
        `${hiddenMetrics.length === 1 ? "is" : "are"} currently hidden.`,
    );
  }

  return { desc: sentences.join(" "), title };
}

function describeDelta(delta: number, unit: string): string {
  if (Math.abs(delta) < 0.05) return `the same ${unit}`;
  return `${round(Math.abs(delta))} ${unit} ${delta > 0 ? "more" : "less"}`;
}
