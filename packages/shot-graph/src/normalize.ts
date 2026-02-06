import type {
  Annotation,
  ChartDataPoint,
  ShotData,
  ShotDatapoints,
  ShotMeta,
} from "./types";

const SCALE = 10;

function norm(value: number): number {
  return value / SCALE;
}

function normAt(arr: number[] | undefined, i: number): number | undefined {
  return arr?.[i] !== undefined ? norm(arr[i]) : undefined;
}

export function extractMeta(shot: ShotData): ShotMeta {
  const weights = shot.datapoints.shotWeight ?? [];
  const lastWeight = weights.length > 0 ? norm(weights[weights.length - 1]) : 0;
  return {
    id: shot.id,
    profileName: shot.profile.name ?? "Unknown",
    duration: shot.duration / SCALE,
    weight: lastWeight,
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
  const len = dp.timeInShot?.length ?? 0;

  const points: Map<number, ChartDataPoint> = new Map();
  for (let i = 0; i < len; i++) {
    const time = norm(dp.timeInShot[i]);
    points.set(time, { time, ...extractSeries(dp, i) });
  }

  if (comparison) {
    const cdp = comparison.datapoints;
    const clen = cdp.timeInShot?.length ?? 0;
    for (let i = 0; i < clen; i++) {
      const time = norm(cdp.timeInShot[i]);
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
  const firstDripIdx = shotWeight?.findIndex((w) => w > 5) ?? -1;
  if (firstDripIdx >= 0 && timeInShot[firstDripIdx] !== undefined) {
    annotations.push({
      time: norm(timeInShot[firstDripIdx]),
      value: norm(shotWeight[firstDripIdx]),
      yAxisId: "right",
      label: "First drip",
      color: "var(--chart-weight)",
    });
  }

  // Peak pressure: index of max pressure value
  if (pressure?.length) {
    let maxVal = -1;
    let maxIdx = 0;
    for (let i = 0; i < pressure.length; i++) {
      if (pressure[i] > maxVal) {
        maxVal = pressure[i];
        maxIdx = i;
      }
    }
    if (timeInShot[maxIdx] !== undefined) {
      const normalizedPressure = norm(maxVal);
      annotations.push({
        time: norm(timeInShot[maxIdx]),
        value: normalizedPressure,
        yAxisId: "left",
        label: `${normalizedPressure.toFixed(1)} bar`,
        color: "var(--chart-pressure)",
      });
    }
  }

  return annotations;
}
