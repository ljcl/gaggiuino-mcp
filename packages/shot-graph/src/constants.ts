/** Chart colors via CSS variables — theme-aware (light/dark overrides in tokens.css) */
export const COLORS = {
  pressure: "var(--chart-pressure)",
  targetPressure: "var(--chart-target-pressure)",
  pumpFlow: "var(--chart-flow)",
  targetPumpFlow: "var(--chart-target-flow)",
  weightFlow: "var(--chart-weight-flow)",
  shotWeight: "var(--chart-weight)",
} as const;

export interface MetricConfig {
  key: "pressure" | "pumpFlow" | "weightFlow" | "shotWeight";
  label: string;
  color: string;
}

export const METRICS: MetricConfig[] = [
  { key: "pressure", label: "Pressure", color: COLORS.pressure },
  { key: "pumpFlow", label: "Flow", color: COLORS.pumpFlow },
  { key: "weightFlow", label: "Weight Flow", color: COLORS.weightFlow },
  { key: "shotWeight", label: "Weight", color: COLORS.shotWeight },
];

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
