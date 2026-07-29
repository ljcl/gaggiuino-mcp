import { type PhaseRegion, type ShotData } from "./types";

/**
 * Split a shot into its profile's phases.
 *
 * The machine sends `profile.phases[].type` with every shot and the chart used
 * to discard it, inferring unlabeled boundaries from the target series and
 * de-duplicating them with a magic `MIN_GAP = 4` seconds. That gap was the only
 * thing bounding how many boundaries a noisy target trace could produce, and it
 * was tuned against nothing in particular: a profile with two phases four
 * seconds apart lost one, a ramp with a stepped target gained several.
 *
 * The profile is the authority on how many phases a shot has, so it is what
 * bounds the count here. Transitions are still detected from the target series
 * — the datapoints carry no phase index, so there is nothing else to detect
 * them from — but only the strongest `phases.length - 1` survive, and each
 * region takes its label from the phase at the same position.
 *
 * The detection rule is deliberately the same one `apps/server`'s
 * `extractPhaseSummary` uses, so the chart and `get_shot_data` describe the
 * same phases rather than two plausible different sets.
 */

/** Raw units. A target-pressure step this large is a phase change, not noise. */
const PRESSURE_STEP = 10;

interface Candidate {
  /** Index into the datapoint arrays where the new phase begins. */
  index: number;
  /** How decisively the target series moved; used to rank, never to threshold. */
  strength: number;
}

function findCandidates(shot: ShotData): Candidate[] {
  const { targetPressure = [], targetPumpFlow = [] } = shot.datapoints;
  const length = Math.max(targetPressure.length, targetPumpFlow.length);
  const candidates: Candidate[] = [];

  for (let i = 1; i < length; i++) {
    const prevFlow = targetPumpFlow[i - 1] ?? 0;
    const flow = targetPumpFlow[i] ?? 0;
    const prevPressure = targetPressure[i - 1] ?? 0;
    const pressure = targetPressure[i] ?? 0;

    // A flow target switching on or off is the clearest phase change there is:
    // it is how a fill or preinfusion phase hands over to extraction.
    const flowTransition = (prevFlow === 0) !== (flow === 0);
    const pressureDelta = Math.abs(pressure - prevPressure);
    const pressureTransition = pressureDelta > PRESSURE_STEP;

    if (flowTransition || pressureTransition) {
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

/** "PRESSURE" → "Pressure"; "SOAK_AND_RAMP" → "Soak and ramp". */
function prettifyPhaseType(type: string): string {
  const words = type
    .trim()
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean);
  const [first, ...rest] = words;
  if (first === undefined) return "";
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function labelFor(type: string | undefined, index: number): string {
  const pretty = type === undefined ? "" : prettifyPhaseType(type);
  return pretty === "" ? `Phase ${index + 1}` : pretty;
}

export function derivePhaseRegions(shot: ShotData): PhaseRegion[] {
  const times = shot.datapoints.timeInShot ?? [];
  const phases = shot.profile?.phases ?? [];
  // Without a phase list there is nothing to label, and an unlabeled boundary
  // is the thing this replaced. Better to draw none than to invent them.
  if (phases.length === 0 || times.length === 0) return [];

  const first = times[0];
  const last = times.at(-1);
  if (first === undefined || last === undefined) return [];

  const boundaries = findCandidates(shot)
    // Rank by strength, keep what the profile has room for, then put the
    // survivors back in time order.
    .sort((a, b) => b.strength - a.strength)
    .slice(0, phases.length - 1)
    .map((c) => c.index)
    .sort((a, b) => a - b);

  const startIndexes = [0, ...boundaries];
  return startIndexes.map((startIndex, i) => {
    const nextStart = startIndexes[i + 1];
    const endIndex = nextStart === undefined ? times.length - 1 : nextStart;
    return {
      end: (times[endIndex] ?? last) / 10,
      index: i,
      label: labelFor(phases[i]?.type, i),
      start: (times[startIndex] ?? first) / 10,
    };
  });
}
