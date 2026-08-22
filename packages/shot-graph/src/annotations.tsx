import { ReferenceDot, ReferenceLine } from "recharts";
import { COMPARISON_OPACITY, TARGET_DASH } from "./constants";
import { type Annotation } from "./types";

/*
 * Comparison annotations are marked by a hollow dot and a smaller label, not
 * by transparency: annotation labels are text and must hold 4.5:1 against the
 * chart background.
 */

interface AnnotationPair {
  primary: Annotation;
  comparison: Annotation;
}

/** Resolves annotations into paired (connected) and unpaired (standalone) groups */
function pairAnnotations(
  primary?: Annotation[],
  comparison?: Annotation[],
): {
  pairs: AnnotationPair[];
  unpairedPrimary: Annotation[];
  unpairedComparison: Annotation[];
} {
  const pairs: AnnotationPair[] = [];
  const matchedCmp = new Set<number>();

  const unpairedPrimary: Annotation[] = [];
  const cmpList = comparison ?? [];
  for (const p of primary ?? []) {
    const cmpIdx = cmpList.findIndex(
      (c, i) => c.metric === p.metric && !matchedCmp.has(i),
    );
    const match = cmpIdx >= 0 ? cmpList[cmpIdx] : undefined;
    if (match) {
      matchedCmp.add(cmpIdx);
      pairs.push({ primary: p, comparison: match });
    } else {
      unpairedPrimary.push(p);
    }
  }
  const unpairedComparison = (comparison ?? []).filter(
    (_, i) => !matchedCmp.has(i),
  );
  return { pairs, unpairedPrimary, unpairedComparison };
}

/**
 * Determines label position for an annotation dot.
 * Right-axis annotations near the bottom (value < 2) get label on top to avoid
 * overlapping the X-axis. The `invert` flag flips the default for comparison dots.
 */
function annotationLabelPosition(
  a: Annotation,
  invert = false,
): "top" | "bottom" {
  if (a.yAxisId === "right") {
    const nearBottom = a.value < 2;
    const defaultPos = nearBottom ? "top" : "bottom";
    if (invert) return defaultPos === "top" ? "bottom" : "top";
    return defaultPos;
  }
  const defaultPos = "top";
  if (invert) return defaultPos === "top" ? "bottom" : "top";
  return defaultPos;
}

/** Builds the annotation JSX elements: connectors for pairs, standalone dots otherwise */
export function renderAnnotations({
  annotations,
  comparisonAnnotations,
  show,
  primaryFont,
  comparisonFont,
}: {
  annotations?: Annotation[];
  comparisonAnnotations?: Annotation[];
  show: (key: string) => boolean;
  primaryFont: number;
  comparisonFont: number;
}) {
  const { pairs, unpairedPrimary, unpairedComparison } = pairAnnotations(
    annotations,
    comparisonAnnotations,
  );

  const elements: React.ReactNode[] = [];

  // Connector lines between paired annotations (via ReferenceLine segment)
  for (const { primary, comparison } of pairs) {
    const primaryKey = primary.yAxisId === "right" ? "shotWeight" : "pressure";
    const cmpKey =
      primary.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(primaryKey) || !show(cmpKey)) continue;
    elements.push(
      <ReferenceLine
        key={`conn-${primary.metric}`}
        yAxisId={primary.yAxisId}
        segment={[
          { x: primary.time, y: primary.value },
          { x: comparison.time, y: comparison.value },
        ]}
        stroke={primary.color}
        strokeWidth={1}
        strokeDasharray={TARGET_DASH}
        opacity={COMPARISON_OPACITY}
      />,
    );
  }

  // Paired primary dots (filled, label on primary side)
  for (const { primary } of pairs) {
    const visibleKey = primary.yAxisId === "right" ? "shotWeight" : "pressure";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`paired-${primary.metric}`}
        x={primary.time}
        y={primary.value}
        yAxisId={primary.yAxisId}
        r={4}
        fill={primary.color}
        stroke="var(--color-background-primary)"
        strokeWidth={2}
        label={{
          value: primary.label,
          position: annotationLabelPosition(primary),
          fill: primary.color,
          fontSize: primaryFont,
          fontWeight: 600,
          offset: 8,
        }}
      />,
    );
  }

  // Paired comparison dots (open, label on opposite side)
  for (const { primary, comparison } of pairs) {
    const visibleKey =
      primary.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`paired-cmp-${comparison.metric}`}
        x={comparison.time}
        y={comparison.value}
        yAxisId={comparison.yAxisId}
        r={4}
        fill="none"
        stroke={comparison.color}
        strokeWidth={1.5}
        opacity={COMPARISON_OPACITY}
        label={{
          value: comparison.label,
          position: annotationLabelPosition(comparison, true),
          fill: comparison.color,
          fontSize: comparisonFont,
          fontWeight: 500,
          offset: 8,
        }}
      />,
    );
  }

  // Unpaired primary dots
  for (const a of unpairedPrimary) {
    const visibleKey = a.yAxisId === "right" ? "shotWeight" : "pressure";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={a.metric}
        x={a.time}
        y={a.value}
        yAxisId={a.yAxisId}
        r={4}
        fill={a.color}
        stroke="var(--color-background-primary)"
        strokeWidth={2}
        label={{
          value: a.label,
          position: annotationLabelPosition(a),
          fill: a.color,
          fontSize: primaryFont,
          fontWeight: 600,
          offset: 8,
        }}
      />,
    );
  }

  // Unpaired comparison dots
  for (const a of unpairedComparison) {
    const visibleKey = a.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`cmp-${a.metric}`}
        x={a.time}
        y={a.value}
        yAxisId={a.yAxisId}
        r={4}
        fill="none"
        stroke={a.color}
        strokeWidth={1.5}
        opacity={COMPARISON_OPACITY}
        label={{
          value: a.label,
          position: annotationLabelPosition(a, true),
          fill: a.color,
          fontSize: comparisonFont,
          fontWeight: 500,
          offset: 8,
        }}
      />,
    );
  }

  return elements;
}
