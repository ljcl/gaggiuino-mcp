import type { ShotData } from "./client";

export const SCALE_BY_10 = new Set([
  "pressure",
  "targetPressure",
  "temperature",
  "targetTemperature",
  "pumpFlow",
  "weightFlow",
  "targetPumpFlow",
  "shotWeight",
  "waterPumped",
  "timeInShot",
]);

export function normalizeValue(value: number, fieldName: string): number {
  if (SCALE_BY_10.has(fieldName)) {
    return value / 10;
  }
  return value;
}

function getLastNormalized(values: number[], fieldName: string): number {
  const last = values.at(-1);
  if (last === undefined) return 0;
  return normalizeValue(last, fieldName);
}

function getMaxNormalized(values: number[], fieldName: string): number {
  if (values.length === 0) return 0;
  return normalizeValue(Math.max(...values), fieldName);
}

export interface OutcomeMetrics {
  shotId: string;
  profileName: string;
  totalDurationSec: number;
  finalWeightG: number;
  peakPressureBar: number;
  waterPumpedMl: number;
  timeToFirstDripSec: number | null;
  tempStability: string;
  targetWeightG: number | null;
}

export interface PhaseSummary {
  phaseNumber: number;
  type: string;
  durationSec: number;
  samples: {
    entry: { pressure: number; flow: number; weight: number };
    mid: { pressure: number; flow: number; weight: number };
    exit: { pressure: number; flow: number; weight: number };
  };
  events: string[];
}

export interface ShotSummary {
  outcomeMetrics: OutcomeMetrics;
  phases: PhaseSummary[];
}

export function extractOutcomeMetrics(shotData: ShotData): OutcomeMetrics {
  const { datapoints, profile } = shotData;

  const times = datapoints.timeInShot ?? [];
  const pressures = datapoints.pressure ?? [];
  const shotWeights = datapoints.shotWeight ?? [];
  const waterPumped = datapoints.waterPumped ?? [];
  const temperatures = datapoints.temperature ?? [];

  // Find time to first drip (weight > 0.5g = 5 in API units)
  let timeToFirstDripSec: number | null = null;
  for (let i = 0; i < shotWeights.length; i += 1) {
    const weight = shotWeights[i];
    const time = times[i];
    if (weight !== undefined && weight > 5 && time !== undefined) {
      timeToFirstDripSec = normalizeValue(time, "timeInShot");
      break;
    }
  }

  // Calculate temperature stability
  let tempStability = "stable";
  if (temperatures.length > 0) {
    const minTemp = normalizeValue(Math.min(...temperatures), "temperature");
    const maxTemp = normalizeValue(Math.max(...temperatures), "temperature");
    const drift = maxTemp - minTemp;
    if (drift > 1.0) {
      tempStability = `drifted +${drift.toFixed(1)}C`;
    }
  }

  const globalStop = profile.globalStopConditions;
  const targetWeight = globalStop?.weight ?? null;

  return {
    shotId: shotData.id,
    profileName: profile.name ?? "Unknown",
    totalDurationSec: shotData.duration / 10,
    finalWeightG: getLastNormalized(shotWeights, "shotWeight"),
    peakPressureBar: getMaxNormalized(pressures, "pressure"),
    waterPumpedMl: getLastNormalized(waterPumped, "waterPumped"),
    timeToFirstDripSec,
    tempStability,
    targetWeightG: targetWeight,
  };
}

function sampleAtIndex(
  datapoints: ShotData["datapoints"],
  idx: number,
): { pressure: number; flow: number; weight: number } {
  const rawPressure = datapoints.pressure?.[idx];
  const rawFlow = datapoints.pumpFlow?.[idx];
  const rawWeight = datapoints.shotWeight?.[idx];
  return {
    pressure:
      rawPressure !== undefined ? normalizeValue(rawPressure, "pressure") : 0,
    flow: rawFlow !== undefined ? normalizeValue(rawFlow, "pumpFlow") : 0,
    weight:
      rawWeight !== undefined ? normalizeValue(rawWeight, "shotWeight") : 0,
  };
}

function extractPhaseSummary(shotData: ShotData): PhaseSummary[] {
  const { datapoints, profile } = shotData;
  const times = datapoints.timeInShot ?? [];
  const targetPressure = datapoints.targetPressure ?? [];
  const targetFlow = datapoints.targetPumpFlow ?? [];
  const profilePhases = profile.phases ?? [];

  if (times.length === 0) {
    return [];
  }

  const targets = targetPressure.length > 0 ? targetPressure : targetFlow;
  const boundaries: Array<[number, number]> = [];
  let phaseStart = 0;

  for (let i = 1; i < targets.length; i += 1) {
    const prevP = targetPressure[i - 1] ?? 0;
    const currP = targetPressure[i] ?? 0;
    const prevF = targetFlow[i - 1] ?? 0;
    const currF = targetFlow[i] ?? 0;

    const flowTransition = (prevF === 0) !== (currF === 0);
    const pressureTransition = Math.abs(currP - prevP) > 10;

    if (flowTransition || pressureTransition) {
      boundaries.push([phaseStart, i - 1]);
      phaseStart = i;
    }
  }
  boundaries.push([phaseStart, targets.length - 1]);

  return boundaries.map(([startIdx, endIdx], i) => {
    const startTimeRaw = times[startIdx];
    const endTimeRaw = times[endIdx];
    const startTime =
      startTimeRaw !== undefined
        ? normalizeValue(startTimeRaw, "timeInShot")
        : 0;
    const endTime =
      endTimeRaw !== undefined ? normalizeValue(endTimeRaw, "timeInShot") : 0;
    const midIdx = Math.floor((startIdx + endIdx) / 2);

    const phaseType = profilePhases[i]?.type ?? "UNKNOWN";

    return {
      phaseNumber: i + 1,
      type: phaseType,
      durationSec: endTime - startTime,
      samples: {
        entry: sampleAtIndex(datapoints, startIdx),
        mid: sampleAtIndex(datapoints, midIdx),
        exit: sampleAtIndex(datapoints, endIdx),
      },
      events: [],
    };
  });
}

export function generateShotSummary(shotData: ShotData): ShotSummary {
  return {
    outcomeMetrics: extractOutcomeMetrics(shotData),
    phases: extractPhaseSummary(shotData),
  };
}

function formatWeightLine(metrics: OutcomeMetrics): string {
  const final = metrics.finalWeightG;
  const target = metrics.targetWeightG;
  if (target !== null) {
    const diff = final - target;
    const sign = diff >= 0 ? "+" : "";
    return `  Final Weight: ${final.toFixed(1)}g (target: ${target}g, ${sign}${diff.toFixed(1)}g)`;
  }
  return `  Final Weight: ${final.toFixed(1)}g`;
}

export function formatShotSummary(summary: ShotSummary): string {
  const { outcomeMetrics: metrics, phases } = summary;

  const lines = [
    `Shot #${metrics.shotId} Summary`,
    `Profile: ${metrics.profileName}`,
    "",
    "=== Outcome Metrics ===",
    `  Duration: ${metrics.totalDurationSec.toFixed(1)}s`,
    formatWeightLine(metrics),
    `  Time to First Drip: ${metrics.timeToFirstDripSec ?? "N/A"}s`,
    `  Peak Pressure: ${metrics.peakPressureBar.toFixed(1)} bar`,
    `  Water Pumped: ${metrics.waterPumpedMl.toFixed(1)}ml`,
    `  Temperature: ${metrics.tempStability}`,
    "",
    "=== Phase Breakdown ===",
  ];

  for (const phase of phases) {
    lines.push(`\nPhase ${phase.phaseNumber} (${phase.type}):`);
    lines.push(`  Duration: ${phase.durationSec}s`);
    lines.push(
      `  Entry: ${phase.samples.entry.pressure.toFixed(1)} bar, ${phase.samples.entry.flow.toFixed(1)} ml/s`,
    );
    lines.push(
      `  Exit:  ${phase.samples.exit.pressure.toFixed(1)} bar, ${phase.samples.exit.flow.toFixed(1)} ml/s`,
    );
    if (phase.events.length > 0) {
      lines.push("  Events:");
      for (const event of phase.events) {
        lines.push(`    - ${event}`);
      }
    }
  }

  return lines.join("\n");
}
