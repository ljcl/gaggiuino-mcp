import { Legend, LegendItem } from "@gaggiuino/ui";
import { COLORS, METRICS, SERIES_DASH } from "./constants";

interface ChartLegendProps {
  hidden: Set<string>;
  /** Toggles every key in one update, so paired series never race each other. */
  onToggle: (keys: readonly string[]) => void;
  hasComparison: boolean;
  mode: "mobile" | "desktop";
}

/**
 * Legend below the chart. On desktop, renders a primary row plus an optional
 * faded comparison row so each series can be toggled independently. On mobile,
 * collapses to a single touch-sized row of 4 items; tapping one toggles the
 * primary and comparison series for that metric together.
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
          <LegendItem
            color={COLORS.pressure}
            dash={SERIES_DASH.pressure}
            label="Pressure (cmp)"
            faded
            hidden={hidden.has("pressureCmp")}
            onClick={() => onToggle(["pressureCmp"])}
          />
          <LegendItem
            color={COLORS.pumpFlow}
            dash={SERIES_DASH.pumpFlow}
            label="Flow (cmp)"
            faded
            hidden={hidden.has("pumpFlowCmp")}
            onClick={() => onToggle(["pumpFlowCmp"])}
          />
          <LegendItem
            color={COLORS.weightFlow}
            dash={SERIES_DASH.weightFlow}
            label="Weight Flow (cmp)"
            faded
            hidden={hidden.has("weightFlowCmp")}
            onClick={() => onToggle(["weightFlowCmp"])}
          />
          <LegendItem
            color={COLORS.shotWeight}
            dash={SERIES_DASH.shotWeight}
            label="Weight (cmp)"
            faded
            hidden={hidden.has("shotWeightCmp")}
            onClick={() => onToggle(["shotWeightCmp"])}
          />
        </Legend>
      )}
    </div>
  );
}
