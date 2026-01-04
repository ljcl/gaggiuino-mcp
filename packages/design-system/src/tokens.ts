/** Surface colors — light mode defaults (overridden by host CSS vars at runtime) */
export const COLORS = {
  background: {
    primary: "#ffffff",
    secondary: "#f5f4ed",
    tertiary: "#faf9f5",
    inverse: "#141413",
  },
  text: {
    primary: "#14141a",
    secondary: "#3d3d3a",
    tertiary: "#73726c",
    inverse: "#ffffff",
    danger: "#7f2c28",
    success: "#275b19",
    info: "#3266ad",
  },
  border: {
    primary: "rgba(31, 30, 29, 0.40)",
    secondary: "rgba(31, 30, 29, 0.30)",
    tertiary: "rgba(31, 30, 29, 0.15)",
  },
} as const;

/** Chart data series colors (Gaggiuino-specific) */
export const CHART_COLORS = {
  pressure: "#2ca02c",
  targetPressure: "rgba(44, 160, 44, 0.35)",
  pumpFlow: "#1f77b4",
  targetPumpFlow: "rgba(31, 119, 180, 0.35)",
  weightFlow: "#b5832a",
  shotWeight: "rgba(107, 66, 38, 0.5)",
} as const;
