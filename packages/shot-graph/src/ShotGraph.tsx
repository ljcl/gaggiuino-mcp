import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend as RechartsLegend,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { renderAnnotations } from "./annotations";
import { ChartLegend } from "./ChartLegend";
import { ChartTooltip } from "./ChartTooltip";
import { COLORS, formatTime } from "./constants";
import styles from "./ShotGraph.module.css";
import { ShotHeader } from "./ShotHeader";
import type { Annotation, ChartDataPoint, ShotMeta } from "./types";

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
  mode?: "mobile" | "desktop";
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
  mode = "desktop",
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

  const isMobile = mode === "mobile";
  const tokens = {
    aspect: isMobile ? 1.1 : 1.8,
    axisFont: isMobile ? 15 : 13,
    annotationFont: isMobile ? 14 : 11,
    annotationFontCmp: isMobile ? 13 : 10,
    chartMarginX: isMobile ? -20 : -30,
  };

  return (
    <div className={styles.root}>
      <ShotHeader
        primary={primaryMeta}
        comparison={comparisonMeta}
        onRequestCompare={onRequestCompare}
        onDismissCompare={onDismissCompare}
        compareLoading={compareLoading}
        mode={mode}
      />
      <ResponsiveContainer width="100%" aspect={tokens.aspect}>
        <ComposedChart
          data={data}
          margin={{
            top: 5,
            right: tokens.chartMarginX,
            left: tokens.chartMarginX,
            bottom: 5,
          }}
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
            fontSize={tokens.axisFont}
            interval="preserveStartEnd"
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 12]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, "auto"]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={5}
            axisLine={false}
            tickLine={false}
          />
          <RechartsTooltip
            content={<ChartTooltip />}
            isAnimationActive={false}
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ pointerEvents: "none", zIndex: 10 }}
          />
          <RechartsLegend
            content={
              <ChartLegend
                hidden={hidden}
                onToggle={toggle}
                hasComparison={!!comparisonMeta}
                mode={mode}
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
            primaryFont: tokens.annotationFont,
            comparisonFont: tokens.annotationFontCmp,
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
