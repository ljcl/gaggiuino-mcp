import { useId, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend as RechartsLegend,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { describeChart } from "./a11y";
import { renderAnnotations } from "./annotations";
import { ChartLegend } from "./ChartLegend";
import { ChartTooltip } from "./ChartTooltip";
import {
  COLORS,
  COMPARISON_OPACITY,
  FURNITURE_DASH,
  formatTime,
  SERIES_DASH,
  TARGET_DASH,
} from "./constants";
import styles from "./ShotGraph.module.css";
import { ShotHeader } from "./ShotHeader";
import { type Annotation, type ChartDataPoint, type ShotMeta } from "./types";

interface ShotGraphProps {
  data: ChartDataPoint[];
  primaryMeta: ShotMeta;
  comparisonMeta?: ShotMeta;
  phaseBoundaries?: number[];
  annotations?: Annotation[];
  comparisonAnnotations?: Annotation[];
  onRequestCompare?: () => void;
  onDismissCompare?: () => void;
  compareLoading?: boolean;
  mode?: "mobile" | "desktop";
  /**
   * Fired with the new set of hidden series keys whenever the user toggles the
   * legend. The chart still owns the state; this only lets the app tell the
   * model what is on screen.
   */
  onVisibilityChange?: (hidden: ReadonlySet<string>) => void;
}

export function ShotGraph({
  data,
  primaryMeta,
  comparisonMeta,
  phaseBoundaries,
  annotations,
  comparisonAnnotations,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
  mode = "desktop",
  onVisibilityChange,
}: ShotGraphProps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Takes a list rather than a single key so the mobile legend, which toggles
  // a metric and its comparison series together, lands both in one update.
  const toggle = (keys: readonly string[]) => {
    const next = new Set(hidden);
    for (const key of keys) {
      if (next.has(key)) next.delete(key);
      else next.add(key);
    }
    setHidden(next);
    onVisibilityChange?.(next);
  };

  const show = (key: string) => !hidden.has(key);

  const isMobile = mode === "mobile";
  const tokens = {
    aspect: isMobile ? 0.95 : 1.8,
    axisFont: isMobile ? 14 : 13,
    annotationFont: isMobile ? 14 : 11,
    annotationFontCmp: isMobile ? 13 : 10,
    chartMarginX: isMobile ? -20 : -30,
    chartMarginTop: isMobile ? 18 : 5,
    strokeWidth: isMobile ? 2.25 : 2,
  };

  // On mobile, drop the "First drip" annotation — its position near the
  // bottom of the right axis collides with x-axis ticks and the comparison
  // label, and peak pressure is the higher-value insight for a glance.
  const visibleAnnotations = isMobile
    ? annotations?.filter((a) => a.metric !== "firstDrip")
    : annotations;
  const visibleComparisonAnnotations = isMobile
    ? comparisonAnnotations?.filter((a) => a.metric !== "firstDrip")
    : comparisonAnnotations;

  // A screen reader gets nothing from the SVG itself, so the chart carries a
  // generated name and description instead. Both track the live state — hide a
  // series and the narration says so.
  const descriptionId = useId();
  const { desc, title } = useMemo(
    () =>
      describeChart({
        annotations,
        comparison: comparisonMeta,
        data,
        hidden,
        primary: primaryMeta,
      }),
    [annotations, comparisonMeta, data, hidden, primaryMeta],
  );

  return (
    <div className={styles.root}>
      <ShotHeader
        primary={primaryMeta}
        comparison={comparisonMeta}
        onRequestCompare={onRequestCompare}
        onDismissCompare={onDismissCompare}
        compareLoading={compareLoading}
        mode={mode}
      />
      <p className={styles.visuallyHidden} id={descriptionId}>
        {desc}
      </p>
      {/*
        `group`, not `img`: the container holds the legend's toggle buttons,
        and `img` makes its whole subtree presentational — which both hides
        those buttons from assistive tech and trips axe's nested-interactive
        rule. `accessibilityLayer` above gives the plot itself keyboard
        traversal, so the chart is genuinely interactive, not a picture.
      */}
      <ResponsiveContainer
        aria-describedby={descriptionId}
        aria-label={title}
        aspect={tokens.aspect}
        role="group"
        width="100%"
      >
        <ComposedChart
          accessibilityLayer
          data={data}
          margin={{
            top: tokens.chartMarginTop,
            right: tokens.chartMarginX,
            left: tokens.chartMarginX,
            bottom: 5,
          }}
        >
          <defs>
            <linearGradient id="gradPressure" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.pressure}
                stopOpacity={0.12}
              />
              <stop offset="100%" stopColor={COLORS.pressure} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradFlow" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.pumpFlow}
                stopOpacity={0.12}
              />
              <stop offset="100%" stopColor={COLORS.pumpFlow} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradWeightFlow" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.weightFlow}
                stopOpacity={0.12}
              />
              <stop
                offset="100%"
                stopColor={COLORS.weightFlow}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            horizontal={true}
            vertical={false}
            strokeDasharray={FURNITURE_DASH}
            stroke="var(--color-border-tertiary)"
          />
          <XAxis
            dataKey="time"
            tickFormatter={formatTime}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            interval="preserveStartEnd"
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 12]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, "auto"]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <RechartsTooltip
            content={<ChartTooltip />}
            isAnimationActive={false}
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ pointerEvents: "none", zIndex: 10 }}
          />
          <RechartsLegend
            content={
              <ChartLegend
                hidden={hidden}
                onToggle={toggle}
                hasComparison={!!comparisonMeta}
                mode={mode}
              />
            }
          />

          {phaseBoundaries?.map((time) => (
            <ReferenceLine
              key={time}
              x={time}
              yAxisId="left"
              stroke="var(--color-border-secondary)"
              strokeDasharray={FURNITURE_DASH}
              strokeWidth={0.5}
            />
          ))}

          {/* Area fills — subtle gradients under primary lines */}
          {show("pressure") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pressure"
              fill="url(#gradPressure)"
              stroke="none"
              connectNulls
              legendType="none"
              name="pressureArea"
            />
          )}
          {show("pumpFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlow"
              fill="url(#gradFlow)"
              stroke="none"
              connectNulls
              legendType="none"
              name="flowArea"
            />
          )}
          {show("weightFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="weightFlow"
              fill="url(#gradWeightFlow)"
              stroke="none"
              connectNulls
              legendType="none"
              name="weightFlowArea"
            />
          )}

          {/* Target lines — subtle dashed */}
          {show("pressure") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPressure"
              name="Pressure Goal"
              stroke={COLORS.targetPressure}
              dot={false}
              strokeWidth={1}
              strokeDasharray={TARGET_DASH}
              connectNulls
              legendType="none"
            />
          )}
          {show("pumpFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPumpFlow"
              name="Flow Goal"
              stroke={COLORS.targetPumpFlow}
              dot={false}
              strokeWidth={1}
              strokeDasharray={TARGET_DASH}
              connectNulls
              legendType="none"
            />
          )}

          {/* Primary lines */}
          {show("pressure") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pressure"
              name="Pressure"
              stroke={COLORS.pressure}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls
            />
          )}
          {show("pumpFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlow"
              name="Flow"
              stroke={COLORS.pumpFlow}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls
            />
          )}
          {show("weightFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="weightFlow"
              name="Weight Flow"
              stroke={COLORS.weightFlow}
              strokeDasharray={SERIES_DASH.weightFlow}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls
            />
          )}
          {show("shotWeight") && (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="shotWeight"
              name="Weight"
              stroke={COLORS.shotWeight}
              strokeDasharray={SERIES_DASH.shotWeight}
              dot={false}
              strokeWidth={isMobile ? 1.75 : 1.5}
              connectNulls
            />
          )}

          {/*
            Comparison lines — same hue as their metric, held apart by stroke
            width. The fade is capped at the 3:1 contrast floor rather than the
            0.45 it used to sit at, which composited to ~2.2:1 on both
            backgrounds. Replacing the fade with a dash outright belongs to the
            comparison-overlay work, not here.
          */}
          {comparisonMeta && show("pressureCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pressureCmp"
              name="Pressure (cmp)"
              stroke={COLORS.pressure}
              dot={false}
              strokeWidth={1}
              opacity={COMPARISON_OPACITY}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("pumpFlowCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlowCmp"
              name="Flow (cmp)"
              stroke={COLORS.pumpFlow}
              dot={false}
              strokeWidth={1}
              opacity={COMPARISON_OPACITY}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("weightFlowCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="weightFlowCmp"
              name="Weight Flow (cmp)"
              stroke={COLORS.weightFlow}
              strokeDasharray={SERIES_DASH.weightFlow}
              dot={false}
              strokeWidth={1}
              opacity={COMPARISON_OPACITY}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("shotWeightCmp") && (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="shotWeightCmp"
              name="Weight (cmp)"
              stroke={COLORS.shotWeight}
              strokeDasharray={SERIES_DASH.shotWeight}
              dot={false}
              strokeWidth={1}
              opacity={COMPARISON_OPACITY}
              connectNulls
              legendType="none"
            />
          )}
          {/* Metric annotations */}
          {renderAnnotations({
            annotations: visibleAnnotations,
            comparisonAnnotations: comparisonMeta
              ? visibleComparisonAnnotations
              : undefined,
            show,
            primaryFont: tokens.annotationFont,
            comparisonFont: tokens.annotationFontCmp,
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
