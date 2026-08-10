import { type ChartDataPoint } from "./types";

/** Chart colors via CSS variables — theme-aware (light/dark overrides in tokens.css) */
export const COLORS = {
  pressure: "var(--chart-pressure)",
  targetPressure: "var(--chart-target-pressure)",
  pumpFlow: "var(--chart-flow)",
  targetPumpFlow: "var(--chart-target-flow)",
  weightFlow: "var(--chart-weight-flow)",
  shotWeight: "var(--chart-weight)",
  temperature: "var(--chart-temperature)",
} as const;

/**
 * The chart's `strokeDasharray` vocabulary, in one place because several
 * different concerns lay claim to it: the chart furniture, the per-series
 * non-color encoding, the goal lines, and the comparison overlay.
 *
 * The series entries are not decoration. Under a deuteranopia/protanopia
 * simulation the palette collapses to roughly two hue poles plus lightness, so
 * the series cannot be told apart by color alone — measured, `flow` and
 * `weightFlow` land ~3 ΔE00 apart once simulated. Pattern is what actually
 * separates them, which makes these values load-bearing rather than stylistic:
 * two series that share a dash must be separated by color, and the
 * "Chart accessibility" story fails the build when neither channel does it.
 *
 * `undefined` means a solid stroke — the two series whose colors *are* far
 * apart keep the cleanest rendering.
 */
export const SERIES_DASH = {
  pressure: undefined,
  pumpFlow: undefined,
  weightFlow: "7 3",
  shotWeight: "1 3",
  temperature: "5 2 1 2",
} as const;

/** Goal lines. One step finer than the furniture, coarser than `shotWeight`. */
export const TARGET_DASH = "4 3";

/** Grid lines and profile phase boundaries — behind the data, never a series. */
export const FURNITURE_DASH = "3 3";

/**
 * Class on the phase-region labels.
 *
 * A plain class rather than a CSS-module one because it is a query hook as much
 * as a style hook: recharts hoists every `Label` into a shared z-index layer at
 * the SVG root, so a phase label does not stay inside its own
 * `.recharts-reference-area` group and cannot be found by walking down from it.
 */
export const PHASE_LABEL_CLASS = "shot-graph-phase-label";

/**
 * A comparison stroke's dash: one long dash, then the metric's own rhythm.
 *
 * Comparison series carry their metric's color, so the dash is the only thing
 * that says "same metric, other shot" without hovering. Deriving it from the
 * primary pattern rather than picking one flat comparison dash is what keeps
 * the accessibility contract satisfiable: a single shared pattern would put
 * `weightFlowCmp` and `pumpFlowCmp` on the same dash *and* ~3 ΔE00 apart under
 * simulation, which is exactly the pair the primary vocabulary had to split.
 * Prefixing preserves whatever separated the primaries.
 *
 * A solid primary yields a plain long dash, which is still unmistakably not
 * solid.
 */
export function comparisonDash(dash: string | undefined): string {
  return dash === undefined ? "10 4" : `10 4 ${dash}`;
}

/**
 * How far a comparison *annotation* may fade before it stops being readable.
 *
 * Measured, not chosen: every `--chart-*` value in both themes still clears
 * 3:1 against `--color-background-primary` when composited at this alpha.
 *
 * Scope note: this used to fade the comparison *lines* too, which is what the
 * dash above replaces. Reference dots and their connectors still use it —
 * there the fade separates a hollow marker from the filled primary one sitting
 * beside it, rather than standing in for an encoding.
 */
export const COMPARISON_OPACITY = 0.75;

export type MetricKey =
  | "pressure"
  | "pumpFlow"
  | "weightFlow"
  | "shotWeight"
  | "temperature";

export interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  /** Matches the series stroke so the legend teaches the encoding. */
  dash?: string;
  /** Unit for the accessible chart description and the tooltip. */
  unit: string;
  /** Which Y scale the metric is drawn against. */
  axis: AxisId;
  /**
   * Off until the user asks for it. A fifth line on a card-sized chart earns
   * its space only when someone is chasing temperature stability.
   */
  hiddenByDefault?: boolean;
}

/** The chart's three Y scales: bar/ml/s, grams, and degrees. */
export type AxisId = "left" | "right" | "temperature";

export const METRICS: MetricConfig[] = [
  {
    axis: "left",
    key: "pressure",
    label: "Pressure",
    color: COLORS.pressure,
    dash: SERIES_DASH.pressure,
    unit: "bar",
  },
  {
    axis: "left",
    key: "pumpFlow",
    label: "Flow",
    color: COLORS.pumpFlow,
    dash: SERIES_DASH.pumpFlow,
    unit: "ml/s",
  },
  {
    axis: "left",
    key: "weightFlow",
    label: "Weight Flow",
    color: COLORS.weightFlow,
    dash: SERIES_DASH.weightFlow,
    unit: "g/s",
  },
  {
    axis: "right",
    key: "shotWeight",
    label: "Weight",
    color: COLORS.shotWeight,
    dash: SERIES_DASH.shotWeight,
    unit: "g",
  },
  {
    axis: "temperature",
    hiddenByDefault: true,
    key: "temperature",
    label: "Temperature",
    color: COLORS.temperature,
    dash: SERIES_DASH.temperature,
    unit: "°C",
  },
];

/** Series keys that start hidden, so the chart opens on the four core metrics. */
export const DEFAULT_HIDDEN_SERIES: ReadonlySet<string> = new Set(
  METRICS.filter((m) => m.hiddenByDefault).flatMap((m) => [
    m.key,
    comparisonKey(m.key),
  ]),
);

/** The legend key for a metric's comparison series. */
export function comparisonKey(metric: MetricKey): string {
  return `${metric}Cmp`;
}

/**
 * One plotted stroke, primary or comparison.
 *
 * This registry is what replaced identifying a comparison series by a `"(cmp)"`
 * substring in its display name. Three call sites matched that string
 * independently — the tooltip filtered on it, the chart styled on it, the
 * legend spelled it out — so a rename was a silent behaviour change in two
 * files that never mentioned each other. `isComparison` is now a field, the
 * suffix is only ever a label, and nothing parses it.
 */
export interface SeriesConfig {
  /** The `ChartDataPoint` field this stroke plots, and its identity in a
   * recharts tooltip payload. */
  dataKey: keyof ChartDataPoint;
  /** Legend/visibility key. Equal to `dataKey` for every current series. */
  key: string;
  metric: MetricConfig;
  /** Human-facing name; recharts also keys its legend and payload by it. */
  name: string;
  color: string;
  dash: string | undefined;
  axis: AxisId;
  isComparison: boolean;
}

function seriesFor(metric: MetricConfig, isComparison: boolean): SeriesConfig {
  const key = isComparison ? comparisonKey(metric.key) : metric.key;
  return {
    axis: metric.axis,
    color: metric.color,
    dash: isComparison ? comparisonDash(metric.dash) : metric.dash,
    dataKey: key as keyof ChartDataPoint,
    isComparison,
    key,
    metric,
    name: isComparison ? `${metric.label} (cmp)` : metric.label,
  };
}

export const PRIMARY_SERIES: SeriesConfig[] = METRICS.map((m) =>
  seriesFor(m, false),
);

export const COMPARISON_SERIES: SeriesConfig[] = METRICS.map((m) =>
  seriesFor(m, true),
);

export const SERIES: SeriesConfig[] = [...PRIMARY_SERIES, ...COMPARISON_SERIES];

/** Lookup by `dataKey`, which is how a tooltip payload entry names itself. */
export const SERIES_BY_KEY: ReadonlyMap<string, SeriesConfig> = new Map(
  SERIES.map((s) => [s.dataKey as string, s]),
);

/**
 * The registry entry for a key the caller already knows is registered.
 *
 * `SERIES_BY_KEY.get` is the right shape for a recharts tooltip payload, whose
 * `dataKey` is whatever the chart happened to put there. It is the wrong shape
 * for a view that decided at author time which strokes it draws: that caller
 * has to handle an `undefined` it cannot produce, and the tidy way to do so —
 * `?? PRIMARY_SERIES[0]` — resolves a *different* metric's colour and dash, so
 * a mistyped key would ship as a plausible-looking chart in the wrong colour
 * rather than as a failure.
 *
 * Throwing keeps that loud. It is not a branch nobody can reach: a series
 * renamed in `METRICS` without its call sites updated lands here, which is
 * exactly when the silent fallback would be worst.
 */
export function requireSeries(key: string): SeriesConfig {
  const series = SERIES_BY_KEY.get(key);
  if (!series) throw new Error(`No chart series is registered for "${key}"`);
  return series;
}

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
