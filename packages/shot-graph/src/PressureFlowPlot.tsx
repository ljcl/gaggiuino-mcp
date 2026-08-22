import { useId, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { describePressureFlowPlot } from "./a11y";
import { FURNITURE_DASH, requireSeries } from "./constants";
import styles from "./ShotGraph.module.css";
import { ShotHeader } from "./ShotHeader";
import { type ChartDataPoint, type ShotMeta } from "./types";

interface PressureFlowPlotProps {
  data: ChartDataPoint[];
  primaryMeta: ShotMeta;
  comparisonMeta?: ShotMeta;
  onRequestCompare?: () => void;
  onDismissCompare?: () => void;
  compareLoading?: boolean;
  mode?: "mobile" | "desktop";
}

/**
 * Did this shot record anything at this timestamp?
 *
 * The distinction this draws is the whole of the filtering rule below, so it is
 * `||` and not `&&` on purpose. `toChartData` merges two shots into one array
 * keyed by time, minting a bare `{ time }` row whenever only the *other* shot
 * has a sample there. Those rows are an artefact of the merge and say nothing
 * about this shot. A row where one of the two readings is genuinely missing is
 * a different thing entirely, and it is kept.
 */
function contributed(
  point: ChartDataPoint,
  pressureKey: "pressure" | "pressureCmp",
  flowKey: "pumpFlow" | "pumpFlowCmp",
): boolean {
  return (
    typeof point[pressureKey] === "number" || typeof point[flowKey] === "number"
  );
}

/**
 * Pressure against flow, time-ordered — the shot as a parametric loop.
 *
 * The time chart shares one x axis across every series, which is the right
 * default and cannot show the one relationship these two have with *each other*.
 * A puck that resists steadily and one that gives way partway through can look
 * similar against time and trace visibly different loops here.
 *
 * Named for the two metrics rather than as a "phase plot", the usual term for a
 * parametric trace, because **`phase` is already taken** in this codebase:
 * `phases.ts`, `PhaseRegion`, `derivePhaseRegions` and `phases[].events` all
 * mean a *profile* phase, and this view draws none of them.
 *
 * ## Why this costs no new strokes and no new bundle
 *
 * **The strokes are the registry's own.** This draws `pressure` and
 * `pressureCmp` — the same `SeriesConfig` entries the time chart draws, same
 * colour, same dash — because flow is an *axis* here, not a series. So there is
 * no new stroke for the Chart accessibility story to measure and no new
 * `--chart-*` token: the contract is satisfied by construction rather than by
 * remembering to register something. The `SingleShot` story asserts every
 * rendered (stroke, dash) pair is a `SERIES` entry, so an unregistered colour
 * fails there instead of shipping.
 *
 * **It is a `Line`, not a `Scatter`.** Recharts' `computeLinePoints` maps the
 * data array in order with no sort, and on a non-category axis the x coordinate
 * comes from each entry's own `dataKey` value — so a `Line` over
 * `<XAxis type="number" dataKey="pumpFlow" />` is a true parametric trace,
 * backtracking and loops included. A `Scatter` would draw the same points and
 * *lose* which of them are consecutive, which is the entire content of the
 * curve. It also keeps the bundle flat — `ComposedChart`, `Line`, `ReferenceDot`
 * and the axes are already imported, where `Scatter` measured +12.4 kB raw /
 * +3.0 kB gzip.
 *
 * Adjacency is not the same as *direction*, though, and a closed-ish loop drawn
 * with no dots reads the same traversed either way. That is what the start
 * markers are for: without one the plot cannot say which end of the curve the
 * shot began at, and the accessible description would be making a claim the
 * picture does not.
 *
 * ## No tooltip, and therefore no `accessibilityLayer`
 *
 * Recharts' `accessibilityLayer` puts `role="application"` and `tabIndex={0}` on
 * the surface, and its arrow-key handler exists solely to move a `Tooltip`. With
 * no tooltip mounted that is a focusable element which tells a screen reader to
 * stop intercepting keystrokes and then answers none of them — nested, here,
 * inside a `role="img"` that declares the subtree presentational.
 *
 * So it is switched **off explicitly**. Omitting the prop does not do it:
 * recharts 3 defaults the layer on, which is also why `ShotGraph`'s explicit
 * flag is a no-op kept for clarity. The container is an `img` because that is
 * what this is — a graphic with no interactive descendants — where `ShotGraph`
 * needs `group` because its legend's toggle buttons live inside the same
 * container.
 *
 * The tooltip is absent because the comparison sits on its own x axis: recharts
 * resolves a tooltip's active point per axis, so a shared readout would report
 * one shot's coordinates while the pointer is over the other's curve — the same
 * silent cross-pairing the second axis exists to prevent. The accessible
 * description carries the numbers a tooltip would.
 */
export function PressureFlowPlot({
  data,
  primaryMeta,
  comparisonMeta,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
  mode = "desktop",
}: PressureFlowPlotProps) {
  const descriptionId = useId();
  const isMobile = mode === "mobile";

  const pressure = requireSeries("pressure");
  const pressureCmp = requireSeries("pressureCmp");

  /*
   * Merge artefacts are dropped; a genuinely one-sided sample is kept so the
   * path breaks at it.
   *
   * This is the opposite of `connectNulls`, and the difference matters here in a
   * way it does not on the time chart. A gap in time can be spanned by a chord
   * and still tell the truth about the ordering. On a parametric axis a missing
   * flow reading has no x position at all, so a chord across it draws a path
   * through the plane the shot never took — and recharts only breaks the path
   * if the point is still *in* the array with a null coordinate. Filtering every
   * incomplete row out, which is the tidy-looking version, silently produces
   * exactly the invented chord.
   */
  const primaryTrace = useMemo(
    () => data.filter((point) => contributed(point, "pressure", "pumpFlow")),
    [data],
  );
  const comparisonTrace = useMemo(
    () =>
      comparisonMeta
        ? data.filter((point) =>
            contributed(point, "pressureCmp", "pumpFlowCmp"),
          )
        : [],
    [comparisonMeta, data],
  );

  const { desc, title } = useMemo(
    () =>
      describePressureFlowPlot({
        comparison: comparisonMeta,
        data: primaryTrace,
        primary: primaryMeta,
      }),
    [comparisonMeta, primaryMeta, primaryTrace],
  );

  /*
   * One shared domain, computed across both traces and pinned on both axes.
   *
   * The comparison needs its own `XAxis` because recharts takes x from a single
   * axis `dataKey` — bound to `pumpFlow`, the comparison line would be plotted
   * against the *primary's* flow, silently pairing readings from two different
   * shots. A second axis keyed on `pumpFlowCmp` fixes that and introduces the
   * real hazard in its place: two independently-scaled axes would overlay two
   * loops that cannot be compared. Hence the explicit shared domain.
   *
   * The lower bound is computed rather than fixed at 0 for that same reason.
   * `allowDataOverflow` is left false, so recharts widens a user domain to fit
   * the data *per axis* — a negative flow reading on one shot only would pull
   * that axis' floor down alone and slide the two loops out of registration.
   */
  const flowDomain = useMemo<[number, number]>(() => {
    const flows = [
      ...primaryTrace.map((point) => point.pumpFlow),
      ...comparisonTrace.map((point) => point.pumpFlowCmp),
    ].filter((flow): flow is number => typeof flow === "number");
    const max = flows.length > 0 ? Math.max(...flows) : 0;
    const min = flows.length > 0 ? Math.min(...flows) : 0;
    // A little headroom so the trace does not run into the axis, and a floor so
    // a shot that never pumped still renders a sane axis rather than [0, 0].
    return [Math.min(0, min), Math.max(1, Math.ceil(max * 1.05))];
  }, [comparisonTrace, primaryTrace]);

  /** Where each trace begins, so the loop says which way it was traversed. */
  const starts = useMemo(() => {
    const firstOf = (
      trace: ChartDataPoint[],
      pressureKey: "pressure" | "pressureCmp",
      flowKey: "pumpFlow" | "pumpFlowCmp",
    ) => {
      const point = trace.find(
        (candidate) =>
          typeof candidate[pressureKey] === "number" &&
          typeof candidate[flowKey] === "number",
      );
      return point
        ? {
            flow: point[flowKey] as number,
            pressure: point[pressureKey] as number,
          }
        : null;
    };
    return {
      comparison: firstOf(comparisonTrace, "pressureCmp", "pumpFlowCmp"),
      primary: firstOf(primaryTrace, "pressure", "pumpFlow"),
    };
  }, [comparisonTrace, primaryTrace]);

  const axisTick = {
    fill: "var(--color-text-secondary)",
    fontSize: isMobile ? 14 : 13,
  };

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
      <ResponsiveContainer
        aria-describedby={descriptionId}
        aria-label={title}
        aspect={isMobile ? 0.95 : 1.6}
        role="img"
        width="100%"
      >
        <ComposedChart
          accessibilityLayer={false}
          data={primaryTrace}
          margin={{ bottom: 16, left: 4, right: 12, top: 8 }}
        >
          <CartesianGrid
            stroke="var(--color-border-tertiary)"
            strokeDasharray={FURNITURE_DASH}
          />
          <XAxis
            dataKey="pumpFlow"
            domain={flowDomain}
            label={{
              fill: "var(--color-text-secondary)",
              offset: -8,
              position: "insideBottom",
              value: "Flow (ml/s)",
            }}
            stroke="var(--color-text-tertiary)"
            tick={axisTick}
            type="number"
          />
          {/*
            Both axes are labelled, at every breakpoint. `ShotGraph` labels
            none of its four — it does not need to, because its legend names
            every series. This view has no legend at all: one trace, and the
            other metric is an axis. Drop either label and nothing on screen
            says which quantity the numbers are.

            The pressure domain is pinned to `ShotGraph`'s own [0, 12] rather
            than left to auto. Two views of one shot that rescale as you toggle
            between them are hard to read against each other, and so are two
            phase plots of different shots.
          */}
          <YAxis
            domain={[0, 12]}
            label={{
              angle: -90,
              fill: "var(--color-text-secondary)",
              position: "insideLeft",
              value: "Pressure (bar)",
            }}
            stroke="var(--color-text-tertiary)"
            tick={axisTick}
            width={isMobile ? 46 : 60}
          />
          {comparisonMeta && (
            <XAxis
              dataKey="pumpFlowCmp"
              domain={flowDomain}
              hide
              type="number"
              xAxisId="comparison"
            />
          )}
          {comparisonMeta && (
            <Line
              data={comparisonTrace}
              dataKey="pressureCmp"
              dot={false}
              isAnimationActive={false}
              name={pressureCmp.name}
              stroke={pressureCmp.color}
              strokeDasharray={pressureCmp.dash}
              strokeWidth={isMobile ? 2 : 1.75}
              type="linear"
              xAxisId="comparison"
            />
          )}
          <Line
            dataKey="pressure"
            dot={false}
            isAnimationActive={false}
            name={pressure.name}
            stroke={pressure.color}
            strokeDasharray={pressure.dash}
            strokeWidth={isMobile ? 2.25 : 2}
            type="linear"
          />
          {/*
            Hollow for the comparison, filled for the primary — the convention
            the annotation markers already use to separate a shot from the one
            overlaid on it.
          */}
          {starts.comparison && (
            <ReferenceDot
              fill="var(--color-background-primary)"
              r={4}
              stroke={pressureCmp.color}
              strokeWidth={1.75}
              x={starts.comparison.flow}
              xAxisId="comparison"
              y={starts.comparison.pressure}
            />
          )}
          {starts.primary && (
            <ReferenceDot
              fill={pressure.color}
              r={4}
              stroke="var(--color-background-primary)"
              strokeWidth={1.5}
              x={starts.primary.flow}
              y={starts.primary.pressure}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
