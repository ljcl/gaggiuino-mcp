import { Tooltip, TooltipEntry } from "@gaggiuino/ui";
import { formatTime, METRICS, SERIES_BY_KEY } from "./constants";

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number | ((entry: unknown) => unknown);
    name?: string | number;
    value?: number | string | ReadonlyArray<number | string>;
    color?: string;
  }>;
  label?: number;
}

/** One row: a metric, the primary reading, and the overlay's if there is one. */
interface Row {
  color: string;
  comparison?: string;
  label: string;
  unit: string;
  value: string;
}

/** Placeholder for a shot that had already ended at this timestamp. */
const NO_READING = "—";

function format(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(1)
    : undefined;
}

/**
 * Recharts tooltip adapter.
 *
 * Renaming a series must not change what the tooltip shows, so entries are
 * matched to the series registry by `dataKey`, never by display name. Area
 * fills and goal lines declare `tooltipType="none"` at the source and never
 * reach this payload.
 *
 * Zero is a reading, not a gap: preinfusion sits at zero flow and the shot
 * starts at zero weight.
 */
export function ChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  const readings = new Map<string, string>();
  for (const entry of payload) {
    const series =
      typeof entry.dataKey === "string"
        ? SERIES_BY_KEY.get(entry.dataKey)
        : undefined;
    const value = format(entry.value);
    if (series && value !== undefined) readings.set(series.key, value);
  }

  const rows: Row[] = [];
  for (const metric of METRICS) {
    const value = readings.get(metric.key);
    const comparison = readings.get(`${metric.key}Cmp`);
    if (value === undefined && comparison === undefined) continue;
    rows.push({
      color: metric.color,
      comparison,
      label: metric.label,
      unit: metric.unit,
      value: value ?? NO_READING,
    });
  }
  if (rows.length === 0) return null;

  return (
    <Tooltip timestamp={formatTime(label ?? 0)}>
      {rows.map((row) => (
        <TooltipEntry
          color={row.color}
          comparison={row.comparison}
          key={row.label}
          label={row.label}
          unit={row.unit}
          value={row.value}
        />
      ))}
    </Tooltip>
  );
}
