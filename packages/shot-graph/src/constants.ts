/** Chart colors via CSS variables — theme-aware (light/dark overrides in tokens.css) */
export const COLORS = {
  pressure: "var(--chart-pressure)",
  targetPressure: "var(--chart-target-pressure)",
  pumpFlow: "var(--chart-flow)",
  targetPumpFlow: "var(--chart-target-flow)",
  weightFlow: "var(--chart-weight-flow)",
  shotWeight: "var(--chart-weight)",
} as const;

/**
 * The chart's `strokeDasharray` vocabulary, in one place because three
 * different concerns lay claim to it: the existing chart furniture, the
 * per-series non-color encoding, and the goal lines.
 *
 * The series entries are not decoration. Under a deuteranopia/protanopia
 * simulation the palette collapses to roughly two hue poles plus lightness, so
 * four series cannot be told apart by color alone — measured, `flow` and
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
} as const;

/** Goal lines. One step finer than the furniture, coarser than `shotWeight`. */
export const TARGET_DASH = "4 3";

/** Grid lines and profile phase boundaries — behind the data, never a series. */
export const FURNITURE_DASH = "3 3";

/**
 * How far a comparison stroke may fade before it stops being readable.
 *
 * Measured, not chosen: every `--chart-*` value in both themes still clears
 * 3:1 against `--color-background-primary` when composited at this alpha. The
 * lowest headroom is `--chart-pressure` in light mode, which bottoms out at
 * 0.69, so this leaves a little margin. It used to be 0.45, which composited
 * to roughly 2.2:1 — under the floor for a graphical object.
 */
export const COMPARISON_OPACITY = 0.75;

export interface MetricConfig {
  key: "pressure" | "pumpFlow" | "weightFlow" | "shotWeight";
  label: string;
  color: string;
  /** Matches the series stroke so the legend teaches the encoding. */
  dash?: string;
  /** Unit for the accessible chart description. */
  unit: string;
}

export const METRICS: MetricConfig[] = [
  {
    key: "pressure",
    label: "Pressure",
    color: COLORS.pressure,
    dash: SERIES_DASH.pressure,
    unit: "bar",
  },
  {
    key: "pumpFlow",
    label: "Flow",
    color: COLORS.pumpFlow,
    dash: SERIES_DASH.pumpFlow,
    unit: "ml/s",
  },
  {
    key: "weightFlow",
    label: "Weight Flow",
    color: COLORS.weightFlow,
    dash: SERIES_DASH.weightFlow,
    unit: "g/s",
  },
  {
    key: "shotWeight",
    label: "Weight",
    color: COLORS.shotWeight,
    dash: SERIES_DASH.shotWeight,
    unit: "g",
  },
];

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
