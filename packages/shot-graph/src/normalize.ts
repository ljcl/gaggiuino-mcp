import {
  type Annotation,
  type ChartDataPoint,
  type ShotData,
  type ShotDatapoints,
  type ShotMeta,
} from "./types";

const SCALE = 10;

function norm(value: number): number {
  return value / SCALE;
}

function normAt(arr: number[] | undefined, i: number): number | undefined {
  const v = arr?.[i];
  return v !== undefined ? norm(v) : undefined;
}

export function extractMeta(shot: ShotData): ShotMeta {
  const weights = shot.datapoints.shotWeight ?? [];
  const last = weights.at(-1);
  return {
    id: shot.id,
    profileName: shot.profile.name ?? "Unknown",
    duration: shot.duration / SCALE,
    weight: last !== undefined ? norm(last) : 0,
  };
}

function extractSeries(
  dp: ShotDatapoints,
  i: number,
): Pick<
  ChartDataPoint,
  | "pressure"
  | "targetPressure"
  | "pumpFlow"
  | "targetPumpFlow"
  | "weightFlow"
  | "shotWeight"
> {
  return {
    pressure: normAt(dp.pressure, i),
    targetPressure: normAt(dp.targetPressure, i),
    pumpFlow: normAt(dp.pumpFlow, i),
    targetPumpFlow: normAt(dp.targetPumpFlow, i),
    weightFlow: normAt(dp.weightFlow, i),
    shotWeight: normAt(dp.shotWeight, i),
  };
}

export function toChartData(
  primary: ShotData,
  comparison?: ShotData,
): ChartDataPoint[] {
  const dp = primary.datapoints;
  const times = dp.timeInShot ?? [];

  const points: Map<number, ChartDataPoint> = new Map();
  for (let i = 0; i < times.length; i++) {
    const raw = times[i];
    if (raw === undefined) continue;
    const time = norm(raw);
    points.set(time, { time, ...extractSeries(dp, i) });
  }

  if (comparison) {
    const cdp = comparison.datapoints;
    const ctimes = cdp.timeInShot ?? [];
    for (let i = 0; i < ctimes.length; i++) {
      const raw = ctimes[i];
      if (raw === undefined) continue;
      const time = norm(raw);
      const existing = points.get(time) ?? { time };
      existing.pressureCmp = normAt(cdp.pressure, i);
      existing.targetPressureCmp = normAt(cdp.targetPressure, i);
      existing.pumpFlowCmp = normAt(cdp.pumpFlow, i);
      existing.targetPumpFlowCmp = normAt(cdp.targetPumpFlow, i);
      existing.weightFlowCmp = normAt(cdp.weightFlow, i);
      existing.shotWeightCmp = normAt(cdp.shotWeight, i);
      points.set(time, existing);
    }
  }

  return Array.from(points.values()).sort((a, b) => a.time - b.time);
}

export function extractAnnotations(shot: ShotData): Annotation[] {
  const annotations: Annotation[] = [];
  const { shotWeight, pressure, timeInShot } = shot.datapoints;

  // First drip: first index where shotWeight > 5 (raw units, = 0.5g)
  if (shotWeight && timeInShot) {
    const firstDripIdx = shotWeight.findIndex((w) => w > 5);
    const firstDripWeight = shotWeight[firstDripIdx];
    const firstDripTime = timeInShot[firstDripIdx];
    if (
      firstDripIdx >= 0 &&
      firstDripWeight !== undefined &&
      firstDripTime !== undefined
    ) {
      annotations.push({
        time: norm(firstDripTime),
        value: norm(firstDripWeight),
        yAxisId: "right",
        label: "First drip",
        color: "var(--chart-weight)",
        metric: "firstDrip",
      });
    }
  }

  // Peak pressure: index of max pressure value
  if (pressure?.length && timeInShot) {
    let maxVal = -1;
    let maxIdx = 0;
    for (let i = 0; i < pressure.length; i++) {
      const p = pressure[i];
      if (p !== undefined && p > maxVal) {
        maxVal = p;
        maxIdx = i;
      }
    }
    const maxTime = timeInShot[maxIdx];
    if (maxTime !== undefined) {
      const normalizedPressure = norm(maxVal);
      annotations.push({
        time: norm(maxTime),
        value: normalizedPressure,
        yAxisId: "left",
        label: `${normalizedPressure.toFixed(1)} bar`,
        color: "var(--chart-pressure)",
        metric: "peakPressure",
      });
    }
  }

  return annotations;
}
