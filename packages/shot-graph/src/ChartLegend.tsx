import { Legend, LegendItem } from "@gaggiuino/ui";
import { COMPARISON_SERIES, METRICS } from "./constants";

interface ChartLegendProps {
  hidden: Set<string>;
  /** Toggles every key in one update, so paired series never race each other. */
  onToggle: (keys: readonly string[]) => void;
  hasComparison: boolean;
  mode: "mobile" | "desktop";
}

/**
 * Legend below the chart. On desktop, renders a primary row plus an optional
 * comparison row so each series can be toggled independently. On mobile,
 * collapses to a single touch-sized row; tapping one toggles the primary and
 * comparison series for that metric together.
 *
 * Both rows draw each series' own `strokeDasharray` in the swatch, including
 * the comparison overlay's. That is the key to the encoding: comparison strokes
 * are told apart from their primary by pattern now rather than by a fade, and a
 * key that omitted the pattern would leave a viewer who cannot separate the two
 * by hue with nothing to read the chart by.
 */
export function ChartLegend({
  hidden,
  onToggle,
  hasComparison,
  mode,
}: ChartLegendProps) {
  if (mode === "mobile") {
    const handleClick = (key: string) => {
      onToggle(hasComparison ? [key, `${key}Cmp`] : [key]);
    };
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          marginTop: 8,
        }}
      >
        <Legend label="Shot series" size="touch">
          {METRICS.map(({ key, label, color, dash }) => (
            <LegendItem
              key={key}
              color={color}
              dash={dash}
              label={label}
              hidden={hidden.has(key)}
              onClick={() => handleClick(key)}
            />
          ))}
        </Legend>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        marginTop: 8,
      }}
    >
      <Legend label="Shot series">
        {METRICS.map(({ key, label, color, dash }) => (
          <LegendItem
            key={key}
            color={color}
            dash={dash}
            label={label}
            hidden={hidden.has(key)}
            onClick={() => onToggle([key])}
          />
        ))}
      </Legend>
      {hasComparison && (
        <Legend label="Comparison shot series">
          {COMPARISON_SERIES.map(({ color, dash, key, name }) => (
            <LegendItem
              key={key}
              color={color}
              dash={dash}
              label={name}
              faded
              hidden={hidden.has(key)}
              onClick={() => onToggle([key])}
            />
          ))}
        </Legend>
      )}
    </div>
  );
}
