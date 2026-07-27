import { toCsv } from "@gaggiuino/ui";
import { type ChartDataPoint, type ShotMeta } from "./types";

/**
 * Columns of the exported CSV, with the header each one gets.
 *
 * Values come from `toChartData`, so they are already in real units — the
 * headers say which, because "pressure" alone is ambiguous in a spreadsheet.
 */
const PRIMARY_COLUMNS = [
  ["time", "time_s"],
  ["pressure", "pressure_bar"],
  ["targetPressure", "target_pressure_bar"],
  ["pumpFlow", "pump_flow_ml_s"],
  ["targetPumpFlow", "target_pump_flow_ml_s"],
  ["weightFlow", "weight_flow_g_s"],
  ["shotWeight", "weight_g"],
] as const satisfies readonly (readonly [keyof ChartDataPoint, string])[];

const COMPARISON_COLUMNS = [
  ["pressureCmp", "cmp_pressure_bar"],
  ["targetPressureCmp", "cmp_target_pressure_bar"],
  ["pumpFlowCmp", "cmp_pump_flow_ml_s"],
  ["targetPumpFlowCmp", "cmp_target_pump_flow_ml_s"],
  ["weightFlowCmp", "cmp_weight_flow_g_s"],
  ["shotWeightCmp", "cmp_weight_g"],
] as const satisfies readonly (readonly [keyof ChartDataPoint, string])[];

/**
 * Serialize the normalized chart series to CSV.
 *
 * Exports the data, not the view: series the user has hidden are still
 * included, because a spreadsheet is where you go to look at what the chart
 * left out.
 */
export function shotCsv(
  data: readonly ChartDataPoint[],
  hasComparison: boolean,
): string {
  const pairs = hasComparison
    ? [...PRIMARY_COLUMNS, ...COMPARISON_COLUMNS]
    : PRIMARY_COLUMNS;
  return toCsv(
    data,
    pairs.map(([key]) => key),
    pairs.map(([, header]) => header),
  );
}

/** File name for an exported shot, naming both shots when comparing. */
export function shotCsvFilename(
  primary: ShotMeta,
  comparison?: ShotMeta,
): string {
  return comparison
    ? `shot-${primary.id}-vs-${comparison.id}.csv`
    : `shot-${primary.id}.csv`;
}
