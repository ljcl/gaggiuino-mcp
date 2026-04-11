import { Tooltip, TooltipEntry } from "@gaggiuino/ui";
import { formatTime } from "./constants";

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}

/**
 * Recharts tooltip adapter. Receives raw payload from recharts and renders
 * a @gaggiuino/ui Tooltip. Filters out target/goal lines, area fills,
 * comparison entries, and zero values.
 */
export function ChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const filtered = payload.filter(
    (e) =>
      !e.name.includes("Goal") &&
      !e.name.includes("Target") &&
      !e.name.includes("Area") &&
      !e.name.includes("(cmp)") &&
      e.value !== 0,
  );
  if (!filtered.length) return null;
  return (
    <Tooltip timestamp={formatTime(label ?? 0)}>
      {filtered.map((entry) => (
        <TooltipEntry
          key={entry.name}
          color={entry.color}
          label={entry.name}
          value={entry.value.toFixed(1)}
        />
      ))}
    </Tooltip>
  );
}
