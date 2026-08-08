import { z } from "zod";
import { type ShotData } from "./client";
import {
  describePressureCollapse,
  detectPressureCollapses,
  type PressureCollapse,
} from "./events";
import { normalizeValue } from "./normalize";

function getLastNormalized(values: number[], fieldName: string): number {
  const last = values.at(-1);
  if (last === undefined) return 0;
  return normalizeValue(last, fieldName);
}

function getMaxNormalized(values: number[], fieldName: string): number {
  if (values.length === 0) return 0;
  return normalizeValue(Math.max(...values), fieldName);
}

/**
 * The shot summary is both this module's return type and the advertised
 * `outputSchema` of the `get_shot_data` tool, so it is defined once here as a
 * zod schema and the TypeScript types are derived from it. Descriptions carry
 * the unit of every numeric field, since the values are already normalized out
 * of the machine's scaled-by-10 wire format.
 */
export const OutcomeMetricsSchema = z.object({
  finalWeightG: z
    .number()
    .describe("Weight in the cup at the end of the shot, in grams"),
  peakPressureBar: z
    .number()
    .describe("Highest pressure reached during the shot, in bar"),
  pressureDeviationBar: z
    .number()
    .nullable()
    .describe(
      "How far group pressure ran from what the profile asked for, averaged over the samples where a pressure target was commanded, in bar; null when the profile drove flow throughout and never commanded one",
    ),
  profileName: z.string().describe("Name of the brew profile used"),
  shotId: z.string().describe("Id of the shot this summary describes"),
  targetWeightG: z
    .number()
    .nullable()
    .describe(
      "Weight the profile was set to stop at, in grams; null when the profile has no weight stop condition",
    ),
  tempDeviationC: z
    .number()
    .nullable()
    .describe(
      "How far boiler temperature ran from what the profile asked for, averaged over the samples where a temperature target was commanded, in degrees Celsius; null when the shot record carries no target temperature",
    ),
  tempStability: z
    .string()
    .describe(
      'Human-readable temperature verdict: "stable", or "drifted +N.NC" when the spread exceeded 1°C. Answers whether the boiler wobbled, which is a different question from whether it was correct — see tempDeviationC',
    ),
  timeToFirstDripSec: z
    .number()
    .nullable()
    .describe(
      "Seconds from shot start until the scale first read above 0.5 g; null when no drip was detected",
    ),
  totalDurationSec: z.number().describe("Total shot duration, in seconds"),
  waterPumpedMl: z
    .number()
    .describe("Total water pushed through the puck, in millilitres"),
});

export type OutcomeMetrics = z.output<typeof OutcomeMetricsSchema>;

const PhaseSampleSchema = z.object({
  flow: z.number().describe("Pump flow at this point, in ml/s"),
  pressure: z.number().describe("Pressure at this point, in bar"),
  weight: z.number().describe("Weight in the cup at this point, in grams"),
});

export const PhaseSummarySchema = z.object({
  durationSec: z.number().describe("Length of this phase, in seconds"),
  events: z
    .array(z.string())
    .describe("Notable events detected within this phase"),
  phaseNumber: z.number().describe("1-based position of the phase in the shot"),
  samples: z
    .object({
      entry: PhaseSampleSchema.describe("Reading at the start of the phase"),
      exit: PhaseSampleSchema.describe("Reading at the end of the phase"),
      mid: PhaseSampleSchema.describe("Reading at the midpoint of the phase"),
    })
    .describe("Readings sampled at the start, midpoint, and end of the phase"),
  type: z
    .string()
    .describe(
      'Phase type as named by the profile, e.g. "FLOW" or "PRESSURE"; "UNKNOWN" when the profile does not name it',
    ),
});

export type PhaseSummary = z.output<typeof PhaseSummarySchema>;

export const ShotSummarySchema = z.object({
  outcomeMetrics: OutcomeMetricsSchema.describe(
    "Headline numbers for the whole shot",
  ),
  phases: z
    .array(PhaseSummarySchema)
    .describe("Phase-by-phase breakdown, in shot order"),
});

export type ShotSummary = z.output<typeof ShotSummarySchema>;

/**
 * How far a measured series ran from the target the profile commanded for it.
 *
 * Mean absolute deviation over the samples where a target was **commanded** —
 * a target of `0` means the profile is not driving that quantity here, not that
 * it asked for zero, and Londinium spends its first five seconds exactly there.
 * Averaging those in would report a shot as ~4 bar off target for doing what it
 * was told.
 *
 * This is the question `tempStability` cannot answer. A spread says whether the
 * boiler wobbled; it says nothing about whether it wobbled around the right
 * number, so a shot held rock-steady three degrees cold reads as "stable".
 *
 * Deliberately a plain mean over every commanded sample, including the moments
 * just after the target steps, when the measured value is still catching up.
 * Excluding a half-second either side of each target change was measured
 * against both captured shots and moved the answer from 0.99 to 0.88 bar and
 * from 1.12 to 0.98 — not enough to justify the extra rule.
 */
function meanDeviationFromTarget(
  measured: number[],
  target: number[],
  fieldName: string,
): number | null {
  let total = 0;
  let counted = 0;

  for (const [i, rawTarget] of target.entries()) {
    const commanded = normalizeValue(rawTarget, fieldName);
    if (commanded <= 0) continue;

    const rawMeasured = measured[i];
    if (rawMeasured === undefined) continue;

    total += Math.abs(normalizeValue(rawMeasured, fieldName) - commanded);
    counted += 1;
  }

  return counted === 0 ? null : total / counted;
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
    tempDeviationC: meanDeviationFromTarget(
      temperatures,
      datapoints.targetTemperature ?? [],
      "temperature",
    ),
    pressureDeviationBar: meanDeviationFromTarget(
      pressures,
      datapoints.targetPressure ?? [],
      "pressure",
    ),
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

/** Raw units. A target-pressure step this large is a phase change, not noise. */
const PRESSURE_STEP = 10;

interface PhaseCandidate {
  /** Index into the datapoint arrays where the new phase begins. */
  index: number;
  /** How decisively the target series moved; used to rank, never to threshold. */
  strength: number;
}

/**
 * Every point at which the target series changes character.
 *
 * Deliberately the same detection **and** selection rule as the chart's
 * `derivePhaseRegions` (`packages/shot-graph/src/phases.ts`), down to the
 * `phases.length - 1` cap — `analysis.test.ts` asserts the two agree phase for
 * phase over the shots captured off a real machine.
 *
 * They were only ever the same in their *detection* half. This function used to
 * keep every transition it found and label the overflow `"UNKNOWN"`, which on a
 * real two-phase shot produced seven phases, five unnamed and three of zero
 * duration, while the chart drew two. The profile is the authority on how many
 * phases a shot has, so it is what bounds the count.
 */
function findPhaseCandidates(
  datapoints: ShotData["datapoints"],
): PhaseCandidate[] {
  const targetPressure = datapoints.targetPressure ?? [];
  const targetFlow = datapoints.targetPumpFlow ?? [];
  // Both series are read, so the longer one bounds the walk. Taking the length
  // from targetPressure alone drops every transition a profile makes after its
  // pressure target stops being reported.
  const length = Math.max(targetPressure.length, targetFlow.length);
  const candidates: PhaseCandidate[] = [];

  for (let i = 1; i < length; i += 1) {
    const prevFlow = targetFlow[i - 1] ?? 0;
    const flow = targetFlow[i] ?? 0;
    const prevPressure = targetPressure[i - 1] ?? 0;
    const pressure = targetPressure[i] ?? 0;

    // A flow target switching on or off is the clearest phase change there is:
    // it is how a fill or preinfusion phase hands over to extraction.
    const flowTransition = (prevFlow === 0) !== (flow === 0);
    const pressureDelta = Math.abs(pressure - prevPressure);

    if (flowTransition || pressureDelta > PRESSURE_STEP) {
      candidates.push({
        index: i,
        // A flow handover outranks any pressure step, so a profile that does
        // both keeps the boundary that means the most.
        strength: flowTransition ? Number.POSITIVE_INFINITY : pressureDelta,
      });
    }
  }

  return candidates;
}

function extractPhaseSummary(shotData: ShotData): PhaseSummary[] {
  const { datapoints, profile } = shotData;
  const times = datapoints.timeInShot ?? [];
  const profilePhases = profile.phases ?? [];

  // Without a phase list there is nothing to name, and an unnamed phase is the
  // thing this replaced. Better to report none than to invent them.
  if (profilePhases.length === 0 || times.length === 0) {
    return [];
  }

  const boundaries = findPhaseCandidates(datapoints)
    // Rank by strength, keep what the profile has room for, then put the
    // survivors back in time order.
    .sort((a, b) => b.strength - a.strength)
    .slice(0, profilePhases.length - 1)
    .map((candidate) => candidate.index)
    .sort((a, b) => a - b);

  const startIndexes = [0, ...boundaries];
  const lastIndex = times.length - 1;
  const collapses = detectPressureCollapses(datapoints);

  return startIndexes.map((startIdx, i) => {
    const nextStart = startIndexes[i + 1];
    // Phases abut in time, exactly as the chart draws them: a phase runs up to
    // the sample where the next one takes over. But that sample already belongs
    // to the next phase, so the last reading *within* this one is the one before
    // it — which is what `exit` reports.
    const boundaryIdx = nextStart ?? lastIndex;
    const exitIdx =
      nextStart === undefined ? lastIndex : Math.max(startIdx, nextStart - 1);
    const midIdx = Math.floor((startIdx + exitIdx) / 2);

    const startTime = normalizeValue(times[startIdx] ?? 0, "timeInShot");
    const endTime = normalizeValue(times[boundaryIdx] ?? 0, "timeInShot");

    return {
      phaseNumber: i + 1,
      // The cap above means the profile always has a phase at this position;
      // the fallback is for a phase the firmware sent without a `type`.
      type: profilePhases[i]?.type ?? "UNKNOWN",
      durationSec: endTime - startTime,
      samples: {
        entry: sampleAtIndex(datapoints, startIdx),
        mid: sampleAtIndex(datapoints, midIdx),
        exit: sampleAtIndex(datapoints, exitIdx),
      },
      events: eventsWithin(
        collapses,
        startTime,
        endTime,
        i === startIndexes.length - 1,
      ),
    };
  });
}

/**
 * The events that began inside one phase's span.
 *
 * Attribution is by **start** time, so a collapse that runs past a phase
 * boundary is reported once, against the phase it started in, rather than
 * twice. The last phase takes the closing boundary inclusively; every other
 * phase ends where the next one begins, and a sample cannot belong to both.
 */
function eventsWithin(
  collapses: PressureCollapse[],
  startTime: number,
  endTime: number,
  isLastPhase: boolean,
): string[] {
  return collapses
    .filter((collapse) => {
      if (collapse.startSec < startTime) return false;
      // Phases abut, so the boundary instant belongs to the phase starting
      // there — otherwise a collapse landing exactly on one is reported twice.
      // Only the final phase owns its closing instant, because nothing follows.
      return isLastPhase
        ? collapse.startSec <= endTime
        : collapse.startSec < endTime;
    })
    .map(describePressureCollapse);
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

/**
 * The headline block, without the phase breakdown.
 *
 * Shared so `get_latest_shot_id` can fold a shot's outcome into its answer
 * without the phase-by-phase detail that makes `get_shot_data` a separate tool.
 */
/** ", 0.4C off target" — or nothing at all when no target was commanded. */
function formatDeviation(deviation: number | null, unit: string): string {
  return deviation === null
    ? ""
    : `, ${deviation.toFixed(1)}${unit} off target`;
}

export function formatOutcomeMetrics(metrics: OutcomeMetrics): string {
  return [
    `Shot #${metrics.shotId} Summary`,
    `Profile: ${metrics.profileName}`,
    "",
    "=== Outcome Metrics ===",
    `  Duration: ${metrics.totalDurationSec.toFixed(1)}s`,
    formatWeightLine(metrics),
    `  Time to First Drip: ${metrics.timeToFirstDripSec ?? "N/A"}s`,
    `  Peak Pressure: ${metrics.peakPressureBar.toFixed(1)} bar`,
    `  Water Pumped: ${metrics.waterPumpedMl.toFixed(1)}ml`,
    `  Temperature: ${metrics.tempStability}${formatDeviation(metrics.tempDeviationC, "C")}`,
    `  Pressure vs target: ${
      metrics.pressureDeviationBar === null
        ? "no pressure target commanded"
        : `${metrics.pressureDeviationBar.toFixed(1)} bar average deviation`
    }`,
  ].join("\n");
}

/** One shot on one line, for listings where a full summary would be noise. */
export function formatShotLine(metrics: OutcomeMetrics): string {
  const weight =
    metrics.targetWeightG !== null
      ? `${metrics.finalWeightG.toFixed(1)}g of ${metrics.targetWeightG}g`
      : `${metrics.finalWeightG.toFixed(1)}g`;
  return [
    `#${metrics.shotId}`,
    metrics.profileName,
    `${metrics.totalDurationSec.toFixed(1)}s`,
    weight,
    `peak ${metrics.peakPressureBar.toFixed(1)} bar`,
    `first drip ${metrics.timeToFirstDripSec === null ? "N/A" : `${metrics.timeToFirstDripSec.toFixed(1)}s`}`,
    `temp ${metrics.tempStability}`,
  ].join(" | ");
}

export function formatShotSummary(summary: ShotSummary): string {
  const { outcomeMetrics: metrics, phases } = summary;

  if (phases.length === 0) {
    // Either the shot carries no readings or its profile named no phases. Both
    // are honest answers, and a bare heading over nothing reads like a bug.
    return [
      formatOutcomeMetrics(metrics),
      "",
      "=== Phase Breakdown ===",
      "  Not available: this shot's profile does not name any phases.",
    ].join("\n");
  }

  const lines = [formatOutcomeMetrics(metrics), "", "=== Phase Breakdown ==="];

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
