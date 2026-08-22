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

/**
 * The pressure-against-flow plot's accessible name and description.
 *
 * Separate from `describeChart` rather than a flag on it, because almost every
 * sentence that function produces is time-domain — "over N seconds", "at N
 * seconds", phases "from X to Y seconds". Reusing it here would narrate a plot
 * that has no time axis in terms of one, confidently and wrongly, and the shared
 * parts (a peak, a weight) are two lines rather than a saving.
 *
 * What a sighted viewer takes from this plot is the *shape of the path*, so that
 * is what this describes: where it starts, where it ends, how far right it
 * reaches, and where pressure peaks along the way. It reports the path and stops
 * there; naming a cause is the reader's job, and a wrong one is worse than none.
 *
 * Deliberately **not** a claim about the loop doubling back. That is the reading
 * a sighted viewer is most likely to draw from the shape, and it is not one this
 * function measures — a "the trace doubles back" sentence would need a threshold
 * on what counts, which is the kind of unearned judgement `apps/server`'s
 * `events.ts` exists to make with measured thresholds, not this function.
 */
export function describePressureFlowPlot({
  comparison,
  data,
  primary,
}: {
  primary: ShotMeta;
  comparison?: ShotMeta;
  data: ChartDataPoint[];
}): ChartDescription {
  const title = comparison
    ? `Espresso pressure against flow: ${primary.profileName} compared with ${comparison.profileName}`
    : `Espresso pressure against flow: ${primary.profileName}`;

  const sentences: string[] = [
    "Parametric plot of group pressure in bar against pump flow in millilitres " +
      `per second, traced in time order over a ${primary.profileName} shot ` +
      `yielding ${round(primary.weight)} grams in ${round(primary.duration)} seconds.`,
  ];

  /*
   * Narrated from the samples that are actually *on* the plot, which is not the
   * same set the caller passes: a sample carrying a pressure but no flow has no
   * horizontal position, so it breaks the drawn path rather than appearing on
   * it. Reading endpoints straight off `data` would report a coordinate the
   * picture does not contain — or, with the obvious `?? 0` guard, invent a
   * reading of zero and present it as measured.
   */
  const plotted = data.flatMap((point) =>
    typeof point.pressure === "number" && typeof point.pumpFlow === "number"
      ? [{ flow: point.pumpFlow, pressure: point.pressure }]
      : [],
  );

  const [first] = plotted;
  const last = plotted.at(-1);
  if (!first || !last) {
    sentences.push("No sample carries both a pressure and a flow reading.");
    return { desc: sentences.join(" "), title };
  }

  const maxFlow = Math.max(...plotted.map((point) => point.flow));
  const peak = plotted.reduce((best, point) =>
    point.pressure > best.pressure ? point : best,
  );

  sentences.push(
    `The trace starts at the marked point, ${round(first.flow)} millilitres per ` +
      `second at ${round(first.pressure)} bar, and ends at ${round(last.flow)} ` +
      `millilitres per second at ${round(last.pressure)} bar. Its maximum flow ` +
      `is ${round(maxFlow)} millilitres per second.`,
  );

  sentences.push(
    `Pressure peaks at ${round(peak.pressure)} bar. ` +
      "On this plot the horizontal position of that peak is the flow the pump " +
      `was delivering when it happened — ${round(peak.flow)} millilitres per ` +
      "second — not a time.",
  );

  if (plotted.length < data.length) {
    const missing = data.length - plotted.length;
    sentences.push(
      `${missing} sample${missing === 1 ? "" : "s"} recorded only one of the two ` +
        "readings and cannot be placed, so the trace is drawn with a break there.",
    );
  }

  if (comparison) {
    sentences.push(
      `A second trace overlays ${comparison.profileName} ` +
        `(${round(comparison.weight)} grams in ${round(comparison.duration)} seconds) ` +
        "in the same colour with a dashed stroke and a hollow start marker.",
    );
  }

  return { desc: sentences.join(" "), title };
}
