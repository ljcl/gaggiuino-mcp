import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Annotation, ChartDataPoint, ShotMeta } from "./types";

/** Chart colors via CSS variables — theme-aware (light/dark overrides in tokens.css) */
const COLORS = {
  pressure: "var(--chart-pressure)",
  targetPressure: "var(--chart-target-pressure)",
  pumpFlow: "var(--chart-flow)",
  targetPumpFlow: "var(--chart-target-flow)",
  weightFlow: "var(--chart-weight-flow)",
  shotWeight: "var(--chart-weight)",
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function MetaSummary({ meta }: { meta: ShotMeta }) {
  return (
    <div>
      <div
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          color: "var(--color-text-primary)",
        }}
      >
        {meta.profileName}
      </div>
      <div
        style={{
          fontSize: "var(--font-text-sm-size)",
          color: "var(--color-text-secondary)",
        }}
      >
        {meta.weight.toFixed(1)}g in {meta.duration.toFixed(1)}s
      </div>
    </div>
  );
}

interface ShotHeaderProps {
  primary: ShotMeta;
  comparison?: ShotMeta;
  onRequestCompare?: () => void;
  onDismissCompare?: () => void;
  compareLoading?: boolean;
}

function ShotHeader({
  primary,
  comparison,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
}: ShotHeaderProps) {
  const buttonStyle: React.CSSProperties = {
    background: "none",
    border: "1px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-sm)",
    padding: "2px 8px",
    fontSize: "var(--font-text-xs-size)",
    color: "var(--color-text-tertiary)",
    cursor: "pointer",
    font: "inherit",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: comparison ? "space-between" : "flex-start",
        alignItems: "flex-start",
        gap: "24px",
        padding: "0 8px",
        marginBottom: "8px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
        <MetaSummary meta={primary} />
        {!comparison && onRequestCompare && (
          <button
            type="button"
            onClick={onRequestCompare}
            disabled={compareLoading}
            style={{
              ...buttonStyle,
              marginTop: "2px",
              opacity: compareLoading ? 0.5 : 1,
            }}
          >
            {compareLoading ? "Loading..." : "Compare previous"}
          </button>
        )}
      </div>
      {comparison && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            textAlign: "right",
            opacity: 0.6,
          }}
        >
          <MetaSummary meta={comparison} />
          {onDismissCompare && (
            <button
              type="button"
              onClick={onDismissCompare}
              style={{
                ...buttonStyle,
                marginTop: "2px",
                padding: "2px 6px",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  // Filter out target/goal lines, area fills, comparison lines, and zero values
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
    <div
      style={{
        background: "var(--color-background-primary)",
        border: "1px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-md)",
        padding: "10px 14px",
        fontSize: "var(--font-text-sm-size)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        backdropFilter: "blur(8px)",
        minWidth: 120,
      }}
    >
      {filtered.map((entry) => (
        <div
          key={entry.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: 1.8,
          }}
        >
          <div
            style={{
              width: 16,
              height: 3,
              backgroundColor: entry.color,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <span style={{ color: "var(--color-text-primary)" }}>
            <span style={{ fontWeight: "var(--font-weight-semibold)" }}>
              {entry.value.toFixed(1)}
            </span>{" "}
            <span style={{ color: "var(--color-text-tertiary)" }}>
              {entry.name}
            </span>
          </span>
        </div>
      ))}
      <div
        style={{
          marginTop: "4px",
          color: "var(--color-text-tertiary)",
          fontSize: "var(--font-text-xs-size)",
        }}
      >
        {formatTime(label ?? 0)}
      </div>
    </div>
  );
}

interface LegendItem {
  key: string;
  color: string;
  label: string;
  faded?: boolean;
}

interface CustomLegendProps {
  items: LegendItem[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}

function CustomLegend({ items, hidden, onToggle }: CustomLegendProps) {
  const primary = items.filter((i) => !i.faded);
  const comparison = items.filter((i) => i.faded);

  const renderItems = (group: LegendItem[]) =>
    group.map(({ key, color, label, faded }) => {
      const isHidden = hidden.has(key);
      return (
        <button
          key={key}
          type="button"
          onClick={() => onToggle(key)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
            opacity: isHidden ? 0.3 : faded ? 0.5 : 1,
            textDecoration: isHidden ? "line-through" : "none",
            userSelect: "none",
            whiteSpace: "nowrap",
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "inherit",
          }}
        >
          <div
            style={{
              width: 16,
              height: 3,
              backgroundColor: color,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <span>{label}</span>
        </button>
      );
    });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "6px",
        marginTop: "8px",
        fontSize: "var(--font-text-xs-size)",
        color: "var(--color-text-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "14px",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {renderItems(primary)}
      </div>
      {comparison.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "14px",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {renderItems(comparison)}
        </div>
      )}
    </div>
  );
}

interface AnnotationPair {
  primary: Annotation;
  comparison: Annotation;
}

/** Resolves annotations into paired (connected) and unpaired (standalone) groups */
function pairAnnotations(
  primary?: Annotation[],
  comparison?: Annotation[],
): {
  pairs: AnnotationPair[];
  unpairedPrimary: Annotation[];
  unpairedComparison: Annotation[];
} {
  const pairs: AnnotationPair[] = [];
  const matchedCmp = new Set<number>();

  const unpairedPrimary: Annotation[] = [];
  for (const p of primary ?? []) {
    const cmpIdx = (comparison ?? []).findIndex(
      (c, i) => c.metric === p.metric && !matchedCmp.has(i),
    );
    if (cmpIdx >= 0) {
      matchedCmp.add(cmpIdx);
      pairs.push({ primary: p, comparison: comparison![cmpIdx] });
    } else {
      unpairedPrimary.push(p);
    }
  }
  const unpairedComparison = (comparison ?? []).filter(
    (_, i) => !matchedCmp.has(i),
  );
  return { pairs, unpairedPrimary, unpairedComparison };
}

/** Builds the annotation JSX elements: connectors for pairs, standalone dots otherwise */
function renderAnnotations({
  annotations,
  comparisonAnnotations,
  show,
}: {
  annotations?: Annotation[];
  comparisonAnnotations?: Annotation[];
  show: (key: string) => boolean;
}) {
  const { pairs, unpairedPrimary, unpairedComparison } = pairAnnotations(
    annotations,
    comparisonAnnotations,
  );

  const elements: React.ReactNode[] = [];

  // Connector lines between paired annotations (via ReferenceLine segment)
  for (const { primary, comparison } of pairs) {
    const primaryKey = primary.yAxisId === "right" ? "shotWeight" : "pressure";
    const cmpKey =
      primary.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(primaryKey) || !show(cmpKey)) continue;
    elements.push(
      <ReferenceLine
        key={`conn-${primary.metric}`}
        yAxisId={primary.yAxisId}
        segment={[
          { x: primary.time, y: primary.value },
          { x: comparison.time, y: comparison.value },
        ]}
        stroke={primary.color}
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.5}
      />,
    );
  }

  // Paired primary dots (filled, label on primary side)
  for (const { primary } of pairs) {
    const visibleKey = primary.yAxisId === "right" ? "shotWeight" : "pressure";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`paired-${primary.metric}`}
        x={primary.time}
        y={primary.value}
        yAxisId={primary.yAxisId}
        r={4}
        fill={primary.color}
        stroke="var(--color-background-primary)"
        strokeWidth={2}
        label={{
          value: primary.label,
          position: primary.yAxisId === "right" ? "bottom" : "top",
          fill: primary.color,
          fontSize: 11,
          fontWeight: 600,
          offset: 8,
        }}
      />,
    );
  }

  // Paired comparison dots (open, label on opposite side)
  for (const { primary, comparison } of pairs) {
    const visibleKey =
      primary.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`paired-cmp-${comparison.metric}`}
        x={comparison.time}
        y={comparison.value}
        yAxisId={comparison.yAxisId}
        r={4}
        fill="none"
        stroke={comparison.color}
        strokeWidth={1.5}
        opacity={0.5}
        label={{
          value: comparison.label,
          position: comparison.yAxisId === "right" ? "top" : "bottom",
          fill: comparison.color,
          fontSize: 10,
          fontWeight: 500,
          opacity: 0.5,
          offset: 8,
        }}
      />,
    );
  }

  // Unpaired primary dots
  for (const a of unpairedPrimary) {
    const visibleKey = a.yAxisId === "right" ? "shotWeight" : "pressure";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={a.metric}
        x={a.time}
        y={a.value}
        yAxisId={a.yAxisId}
        r={4}
        fill={a.color}
        stroke="var(--color-background-primary)"
        strokeWidth={2}
        label={{
          value: a.label,
          position: a.yAxisId === "right" ? "bottom" : "top",
          fill: a.color,
          fontSize: 11,
          fontWeight: 600,
          offset: 8,
        }}
      />,
    );
  }

  // Unpaired comparison dots
  for (const a of unpairedComparison) {
    const visibleKey = a.yAxisId === "right" ? "shotWeightCmp" : "pressureCmp";
    if (!show(visibleKey)) continue;
    elements.push(
      <ReferenceDot
        key={`cmp-${a.metric}`}
        x={a.time}
        y={a.value}
        yAxisId={a.yAxisId}
        r={4}
        fill="none"
        stroke={a.color}
        strokeWidth={1.5}
        opacity={0.5}
        label={{
          value: a.label,
          position: a.yAxisId === "right" ? "top" : "bottom",
          fill: a.color,
          fontSize: 10,
          fontWeight: 500,
          opacity: 0.5,
          offset: 8,
        }}
      />,
    );
  }

  return elements;
}

interface ShotGraphProps {
  data: ChartDataPoint[];
  primaryMeta: ShotMeta;
  comparisonMeta?: ShotMeta;
  phaseBoundaries?: number[];
  annotations?: Annotation[];
  comparisonAnnotations?: Annotation[];
  onRequestCompare?: () => void;
  onDismissCompare?: () => void;
  compareLoading?: boolean;
}

export function ShotGraph({
  data,
  primaryMeta,
  comparisonMeta,
  phaseBoundaries,
  annotations,
  comparisonAnnotations,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
}: ShotGraphProps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const show = (key: string) => !hidden.has(key);

  const legendItems: LegendItem[] = [
    { key: "pressure", color: COLORS.pressure, label: "Pressure" },
    { key: "pumpFlow", color: COLORS.pumpFlow, label: "Flow" },
    { key: "weightFlow", color: COLORS.weightFlow, label: "Weight Flow" },
    { key: "shotWeight", color: COLORS.shotWeight, label: "Weight" },
    ...(comparisonMeta
      ? [
          {
            key: "pressureCmp",
            color: COLORS.pressure,
            label: "Pressure (cmp)",
            faded: true,
          },
          {
            key: "pumpFlowCmp",
            color: COLORS.pumpFlow,
            label: "Flow (cmp)",
            faded: true,
          },
          {
            key: "weightFlowCmp",
            color: COLORS.weightFlow,
            label: "Weight Flow (cmp)",
            faded: true,
          },
          {
            key: "shotWeightCmp",
            color: COLORS.shotWeight,
            label: "Weight (cmp)",
            faded: true,
          },
        ]
      : []),
  ];

  return (
    <div style={{ padding: "0" }}>
      <ShotHeader
        primary={primaryMeta}
        comparison={comparisonMeta}
        onRequestCompare={onRequestCompare}
        onDismissCompare={onDismissCompare}
        compareLoading={compareLoading}
      />
      <ResponsiveContainer width="100%" aspect={1.8}>
        <ComposedChart
          data={data}
          margin={{ top: 5, right: -30, left: -30, bottom: 5 }}
        >
          <defs>
            <linearGradient id="gradPressure" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.pressure}
                stopOpacity={0.12}
              />
              <stop offset="100%" stopColor={COLORS.pressure} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradFlow" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.pumpFlow}
                stopOpacity={0.12}
              />
              <stop offset="100%" stopColor={COLORS.pumpFlow} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradWeightFlow" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={COLORS.weightFlow}
                stopOpacity={0.12}
              />
              <stop
                offset="100%"
                stopColor={COLORS.weightFlow}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            horizontal={true}
            vertical={false}
            strokeDasharray="3 3"
            stroke="var(--color-border-tertiary)"
          />
          <XAxis
            dataKey="time"
            tickFormatter={formatTime}
            stroke="var(--color-text-tertiary)"
            fontSize={13}
            interval="preserveStartEnd"
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 12]}
            stroke="var(--color-text-tertiary)"
            fontSize={13}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, "auto"]}
            stroke="var(--color-text-tertiary)"
            fontSize={13}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<CustomTooltip />}
            isAnimationActive={false}
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ pointerEvents: "none", zIndex: 10 }}
          />
          <Legend
            content={
              <CustomLegend
                items={legendItems}
                hidden={hidden}
                onToggle={toggle}
              />
            }
          />

          {phaseBoundaries?.map((time) => (
            <ReferenceLine
              key={time}
              x={time}
              yAxisId="left"
              stroke="var(--color-border-secondary)"
              strokeDasharray="3 3"
              strokeWidth={0.5}
            />
          ))}

          {/* Area fills — subtle gradients under primary lines */}
          {show("pressure") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pressure"
              fill="url(#gradPressure)"
              stroke="none"
              connectNulls
              legendType="none"
              name="pressureArea"
            />
          )}
          {show("pumpFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlow"
              fill="url(#gradFlow)"
              stroke="none"
              connectNulls
              legendType="none"
              name="flowArea"
            />
          )}
          {show("weightFlow") && (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="weightFlow"
              fill="url(#gradWeightFlow)"
              stroke="none"
              connectNulls
              legendType="none"
              name="weightFlowArea"
            />
          )}

          {/* Target lines — subtle dashed */}
          {show("pressure") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPressure"
              name="Pressure Goal"
              stroke={COLORS.targetPressure}
              dot={false}
              strokeWidth={1}
              strokeDasharray="4 3"
              connectNulls
              legendType="none"
            />
          )}
          {show("pumpFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="targetPumpFlow"
              name="Flow Goal"
              stroke={COLORS.targetPumpFlow}
              dot={false}
              strokeWidth={1}
              strokeDasharray="4 3"
              connectNulls
              legendType="none"
            />
          )}

          {/* Primary lines */}
          {show("pressure") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pressure"
              name="Pressure"
              stroke={COLORS.pressure}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          )}
          {show("pumpFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlow"
              name="Flow"
              stroke={COLORS.pumpFlow}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          )}
          {show("weightFlow") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="weightFlow"
              name="Weight Flow"
              stroke={COLORS.weightFlow}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          )}
          {show("shotWeight") && (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="shotWeight"
              name="Weight"
              stroke={COLORS.shotWeight}
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
          )}

          {/* Comparison lines — solid but faded and thinner */}
          {comparisonMeta && show("pressureCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pressureCmp"
              name="Pressure (cmp)"
              stroke={COLORS.pressure}
              dot={false}
              strokeWidth={1}
              opacity={0.45}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("pumpFlowCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="pumpFlowCmp"
              name="Flow (cmp)"
              stroke={COLORS.pumpFlow}
              dot={false}
              strokeWidth={1}
              opacity={0.45}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("weightFlowCmp") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="weightFlowCmp"
              name="Weight Flow (cmp)"
              stroke={COLORS.weightFlow}
              dot={false}
              strokeWidth={1}
              opacity={0.45}
              connectNulls
              legendType="none"
            />
          )}
          {comparisonMeta && show("shotWeightCmp") && (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="shotWeightCmp"
              name="Weight (cmp)"
              stroke={COLORS.shotWeight}
              dot={false}
              strokeWidth={1}
              opacity={0.35}
              connectNulls
              legendType="none"
            />
          )}
          {/* Metric annotations */}
          {renderAnnotations({
            annotations,
            comparisonAnnotations: comparisonMeta
              ? comparisonAnnotations
              : undefined,
            show,
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
