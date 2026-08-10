import { METRICS } from "./constants";
import { type Annotation, type ShotMeta } from "./types";

export interface ShotContextInput {
  primary: ShotMeta;
  annotations: readonly Annotation[];
  comparison?: ShotMeta;
  comparisonAnnotations?: readonly Annotation[];
  /** Series keys the user has toggled off in the legend. */
  hidden: ReadonlySet<string>;
  /**
   * Which view is on screen. Without it the model is told "series currently
   * plotted: pressure, flow…" while the user is looking at a plot where flow is
   * an *axis* — so it answers questions about a chart that is not there.
   */
  view?: "timeline" | "pressureFlow";
}

function findMetric(
  annotations: readonly Annotation[],
  metric: string,
): Annotation | undefined {
  return annotations.find((annotation) => annotation.metric === metric);
}

function describeShot(
  meta: ShotMeta,
  annotations: readonly Annotation[],
): string {
  const facts = [`${meta.weight.toFixed(1)}g in ${meta.duration.toFixed(1)}s`];

  const peak = findMetric(annotations, "peakPressure");
  if (peak) facts.push(`peak pressure ${peak.value.toFixed(1)} bar`);

  const drip = findMetric(annotations, "firstDrip");
  if (drip) facts.push(`first drip at ${drip.time.toFixed(1)}s`);

  return `Shot #${meta.id} (${meta.profileName}): ${facts.join(", ")}`;
}

/**
 * Describe what the chart is currently showing, for the model's next turn.
 *
 * Without this the model only knows the arguments `view_shot_graph` was called
 * with, so it answers "what does the chart show?" from the tool call rather
 * than from the screen — wrong the moment the user overlays a comparison or
 * hides a series.
 */
export function buildShotContextSummary({
  primary,
  annotations,
  comparison,
  comparisonAnnotations = [],
  hidden,
  view = "timeline",
}: ShotContextInput): string {
  const lines = [
    view === "pressureFlow"
      ? "The user is looking at an interactive espresso shot graph in this conversation, switched to its pressure-against-flow view."
      : "The user is looking at an interactive espresso shot graph in this conversation.",
    "",
    describeShot(primary, annotations),
  ];

  if (comparison) {
    lines.push(
      `Overlaid for comparison — ${describeShot(comparison, comparisonAnnotations)}`,
    );
  }

  if (view === "pressureFlow") {
    // No series list, because on this view there is no series list to give: one
    // trace, and the other metric is the x axis. Saying "plotted: pressure,
    // flow" here would be the same sentence as the timeline's and describe a
    // different picture.
    lines.push(
      "",
      "It plots group pressure against pump flow, traced in time order, so the " +
        "shot reads as a loop rather than as lines against time. The legend and " +
        "the other metrics are not on this view.",
    );
    return lines.join("\n");
  }

  const visible = METRICS.filter(({ key }) => !hidden.has(key));
  lines.push(
    "",
    visible.length === 0
      ? "The user has hidden every series."
      : `Series currently plotted: ${visible.map(({ label }) => label.toLowerCase()).join(", ")}.`,
  );

  const hiddenMetrics = METRICS.filter(({ key }) => hidden.has(key));
  if (hiddenMetrics.length > 0 && visible.length > 0) {
    lines.push(
      `Hidden by the user: ${hiddenMetrics.map(({ label }) => label.toLowerCase()).join(", ")}.`,
    );
  }

  return lines.join("\n");
}
