import { METRICS } from "./constants";
import { type Annotation, type ShotMeta } from "./types";

export interface ShotContextInput {
  primary: ShotMeta;
  annotations: readonly Annotation[];
  comparison?: ShotMeta;
  comparisonAnnotations?: readonly Annotation[];
  /** Series keys the user has toggled off in the legend. */
  hidden: ReadonlySet<string>;
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
}: ShotContextInput): string {
  const lines = [
    "The user is looking at an interactive espresso shot graph in this conversation.",
    "",
    describeShot(primary, annotations),
  ];

  if (comparison) {
    lines.push(
      `Overlaid for comparison — ${describeShot(comparison, comparisonAnnotations)}`,
    );
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
