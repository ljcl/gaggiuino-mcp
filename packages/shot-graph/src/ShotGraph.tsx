import { useId, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend as RechartsLegend,
  Tooltip as RechartsTooltip,
  ReferenceArea,
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
  COMPARISON_SERIES,
  DEFAULT_HIDDEN_SERIES,
  FURNITURE_DASH,
  formatTime,
  PHASE_LABEL_CLASS,
  PRIMARY_SERIES,
  type SeriesConfig,
  TARGET_DASH,
} from "./constants";
import styles from "./ShotGraph.module.css";
import { ShotHeader } from "./ShotHeader";
import {
  type Annotation,
  type ChartDataPoint,
  type PhaseRegion,
  type ShotMeta,
} from "./types";

interface ShotGraphProps {
  data: ChartDataPoint[];
  primaryMeta: ShotMeta;
  comparisonMeta?: ShotMeta;
  /** Labeled spans from the profile; see `derivePhaseRegions`. */
  phases?: PhaseRegion[];
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
  /**
   * Hidden series, when the parent owns them.
   *
   * Optional so every story that renders this component directly keeps working
   * uncontrolled. It exists because the app can now unmount this chart
   * — switching to the pressure-vs-flow view — and an unmount would reset the
   * internal set to the default while the app's own copy, the one that tells the
   * model what is on screen, still held the user's choices. They would diverge
   * silently, with no error anywhere.
   */
  hidden?: ReadonlySet<string>;
}

/**
 * A phase label narrower than this fraction of the shot has nowhere to render
 * without colliding with its neighbour, so the boundary line carries the region
 * alone. The accessible description still names every phase.
 */
const MIN_LABELLED_PHASE_WIDTH = 0.08;

export function ShotGraph({
  data,
  primaryMeta,
  comparisonMeta,
  phases,
  annotations,
  comparisonAnnotations,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
  mode = "desktop",
  onVisibilityChange,
  hidden: controlledHidden,
}: ShotGraphProps) {
  const [uncontrolledHidden, setHidden] = useState<Set<string>>(
    () => new Set(DEFAULT_HIDDEN_SERIES),
  );
  const hidden = controlledHidden ?? uncontrolledHidden;

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
    phaseFont: isMobile ? 11 : 10,
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
        phases,
        primary: primaryMeta,
      }),
    [annotations, comparisonMeta, data, hidden, phases, primaryMeta],
  );

  const showTemperature = show("temperature") || show("temperatureCmp");
  // Degrees need their own scale, but a third axis on a phone-sized card costs
  // more width than it explains — there the tooltip and the accessible
  // description carry the number instead.
  const showTemperatureAxis = showTemperature && !isMobile;
  const phaseSpan = phaseWidth(phases);

  /*
   * Entrance animation is off on every series below, and the dash vocabulary
   * is why. Recharts animates a line by rewriting `stroke-dasharray` each
   * frame, and when the line already *has* a dash it tiles the pattern across
   * the whole path to do it — a 1800px path dashed "1 3" becomes a ~900-entry
   * attribute string, rebuilt every frame, per line, on a chart that can carry
   * ten of them. It also means the attribute never equals what the chart
   * declared, so the encoding the accessibility story measures is not the one
   * the browser is holding.
   */

  /**
   * A comparison stroke stays thinner than its primary, and cumulative weight
   * stays thinner than the pressure/flow traces it crosses — it is a slowly
   * rising line whose job is context, not shape.
   */
  const strokeWidthFor = (series: SeriesConfig) => {
    if (series.isComparison) return 1;
    if (series.metric.key === "shotWeight") return isMobile ? 1.75 : 1.5;
    return tokens.strokeWidth;
  };

  /**
   * One `<Line>` per registry entry, so the dash vocabulary, the axis, and the
   * legend all read from the same record. Comparison strokes differ by dash
   * rather than by a fade: `opacity` was the only thing separating a shot from
   * its overlay, which meant telling them apart required hovering.
   */
  const renderSeries = (series: SeriesConfig) =>
    show(series.key) && (
      <Line
        connectNulls
        dataKey={series.dataKey}
        dot={false}
        isAnimationActive={false}
        key={series.key}
        legendType="none"
        name={series.name}
        stroke={series.color}
        strokeDasharray={series.dash}
        strokeWidth={strokeWidthFor(series)}
        type="monotone"
        yAxisId={series.axis}
      />
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
            /*
             * The negative side margins reclaim padding recharts reserves for
             * one axis per side. A second right-hand axis makes that reclaim
             * wrong: recharts stacks the degrees axis outboard of the weight
             * one, and at -30 its tick labels are laid out past the right edge
             * of the SVG and clipped away — the axis is there, reserving width,
             * showing nothing.
             */
            right: showTemperatureAxis ? 6 : tokens.chartMarginX,
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
          {/*
            Temperature reads in degrees, so it cannot share either scale.

            The window never closes tighter than 88–96 °C: an auto domain over a
            series that holds 93 °C all shot turns ±0.2° of sensor noise into a
            mountain range.
          */}
          <YAxis
            yAxisId="temperature"
            orientation="right"
            domain={temperatureDomain}
            hide={!showTemperatureAxis}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={4}
            axisLine={false}
            tickLine={false}
            width={38}
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

          {/*
            Profile phases: a boundary line where each one starts, and the
            phase's own name above it. The name is the point — the chart used to
            draw these as unlabeled hairlines inferred from the target series
            while `profile.phases[].type` sat unread in the payload.
          */}
          {phases?.map((phase) => (
            <ReferenceArea
              fill="none"
              key={`phase-${phase.index}`}
              label={
                (phase.end - phase.start) / phaseSpan >=
                MIN_LABELLED_PHASE_WIDTH
                  ? {
                      className: PHASE_LABEL_CLASS,
                      fill: "var(--color-text-tertiary)",
                      fontSize: tokens.phaseFont,
                      position: "insideTop",
                      value: phase.label,
                    }
                  : undefined
              }
              stroke="none"
              x1={phase.start}
              x2={phase.end}
              yAxisId="left"
            />
          ))}
          {phases?.slice(1).map((phase) => (
            <ReferenceLine
              key={`phase-edge-${phase.index}`}
              stroke="var(--color-border-secondary)"
              strokeDasharray={FURNITURE_DASH}
              strokeWidth={0.5}
              x={phase.start}
              yAxisId="left"
            />
          ))}

          {/*
            Area fills — subtle gradients under primary lines. `tooltipType`
            keeps them, and the goal lines below, out of the tooltip payload
            entirely, which is what lets the tooltip identify a series by its
            data key instead of sniffing its display name for "Area"/"Goal".
          */}
          {show("pressure") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pressure"
              fill="url(#gradPressure)"
              isAnimationActive={false}
              stroke="none"
              connectNulls
              legendType="none"
              name="pressureArea"
              tooltipType="none"
            />
          )}
          {show("pumpFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlow"
              fill="url(#gradFlow)"
              isAnimationActive={false}
              stroke="none"
              connectNulls
              legendType="none"
              name="flowArea"
              tooltipType="none"
            />
          )}
          {show("weightFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="weightFlow"
              fill="url(#gradWeightFlow)"
              isAnimationActive={false}
              stroke="none"
              connectNulls
              legendType="none"
              name="weightFlowArea"
              tooltipType="none"
            />
          )}

          {/* Target lines — subtle dashed */}
          {show("pressure") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPressure"
              isAnimationActive={false}
              name="Pressure Goal"
              stroke={COLORS.targetPressure}
              dot={false}
              strokeWidth={1}
              strokeDasharray={TARGET_DASH}
              connectNulls
              legendType="none"
              tooltipType="none"
            />
          )}
          {show("pumpFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPumpFlow"
              isAnimationActive={false}
              name="Flow Goal"
              stroke={COLORS.targetPumpFlow}
              dot={false}
              strokeWidth={1}
              strokeDasharray={TARGET_DASH}
              connectNulls
              legendType="none"
              tooltipType="none"
            />
          )}

          {PRIMARY_SERIES.map(renderSeries)}
          {comparisonMeta && COMPARISON_SERIES.map(renderSeries)}

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

/** Total time the phase regions cover; 1 when there are none, to avoid /0. */
function phaseWidth(phases: PhaseRegion[] | undefined): number {
  if (!phases || phases.length === 0) return 1;
  const start = phases[0]?.start ?? 0;
  const end = phases.at(-1)?.end ?? 0;
  return end - start || 1;
}

function temperatureDomain([min, max]: readonly [number, number]): [
  number,
  number,
] {
  return [Math.min(min - 1, 88), Math.max(max + 1, 96)];
}
