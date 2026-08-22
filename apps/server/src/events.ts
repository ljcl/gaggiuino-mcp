import { type ShotData } from "./client";
import { normalizeValue } from "./normalize";

/**
 * Measured extraction events, detected from a shot's own datapoints.
 *
 * The rule for everything in this module: **report what was measured, not what
 * it means.** An event string is prose the model repeats to the user, and the
 * model has `get_dial_in_guidance` in context to interpret it. "Possible
 * channeling" is a judgement; "pressure fell 2.3 bar in 0.6s while the target
 * held at 9.0 bar" is an observation. Only the second belongs here.
 */

/**
 * How fast pressure must fall, sustained, to count as a collapse rather than
 * sensor noise — and how long it must fall for.
 *
 * Both numbers are measured, not inherited. The upstream project this idea
 * comes from (mxkissnr/gaggiuino-local-profiler, `lib/score.js`) flags a drop
 * of more than 1.5 bar between two *adjacent* samples, guarded only by
 * `dt <= 3s`. That threshold is not transferable: it has no window, so its
 * sensitivity moves with the sample interval, and this machine records at
 * ~0.15s. Applied here, 1.5 bar per sample is ~10 bar/s — roughly double what
 * the pump does when the shot *ends*, so it would essentially never fire.
 *
 * The thresholds come from the worst falls measured over steady-target windows
 * on real captures — under 0.9 bar/s benign — so 2.5 bar/s is ~3x the worst
 * noise observed and needs 1.25 bar of real pressure loss in half a second to
 * trigger.
 *
 * `MIN_WINDOW_SEC` is what makes it robust: a single noisy pair on a flat
 * plateau can reach ~2.6 bar/s alone, which would clear the rate threshold.
 * Half a second spans at least three samples at this recording rate, and noise
 * that size does not survive being averaged over three of them.
 */
const COLLAPSE_BAR_PER_SEC = 2.5;
const MIN_WINDOW_SEC = 0.5;

/**
 * How far the target may drift across the window and still count as "held".
 *
 * A tapering profile lowers its own target continuously, and a stepped profile
 * commands multi-bar jumps in a single sample — orders of magnitude larger
 * than any taper's per-window drift — so this cannot be an equality test or
 * the taper reads as a defect on every shot.
 */
const TARGET_HELD_TOLERANCE_BAR = 0.15;

/**
 * How far above its target the measured pressure may sit and still count as
 * tracking it.
 *
 * Generous on purpose. Pressure overshoots its target routinely while the pump
 * settles, and a margin tight enough to call that "not tracking" would exclude
 * the plateau where a real collapse is most likely to happen. It only has to be
 * small compared with the multi-bar gap a commanded step leaves.
 */
const TRACKING_MARGIN_BAR = 1;

export interface PressureCollapse {
  /** Seconds into the shot where the fall began. */
  startSec: number;
  /** Seconds into the shot where it stopped falling. */
  endSec: number;
  /** How far pressure fell, in bar. */
  dropBar: number;
  /** The target the profile was holding while it fell, in bar. */
  targetBar: number;
}

/**
 * One instant of the shot, with the three values every check below reads.
 *
 * Deliberately a list of samples rather than three parallel arrays. Indexing
 * three arrays means three `noUncheckedIndexedAccess` guards per iteration for
 * an `undefined` that the zipping already makes impossible — dead branches that
 * would have to be either covered by a test that cannot be written or paid for
 * out of the coverage threshold.
 */
interface Sample {
  pressure: number;
  target: number;
  time: number;
}

function toSamples(datapoints: ShotData["datapoints"]): Sample[] {
  const time = datapoints.timeInShot ?? [];
  const pressure = datapoints.pressure ?? [];
  const target = datapoints.targetPressure ?? [];

  // Only instants where all three readings exist become samples. The upstream
  // boundary schema requires no two series to agree on length, so this is a
  // shape the firmware can genuinely send — and substituting `0` for a missing
  // reading would be far worse than dropping it: a pressure series that stops
  // early would read as a fall to zero bar against a target still holding at
  // nine, which is a textbook collapse that never happened.
  return Array.from({ length: time.length }, (_, i) => {
    const at = time[i];
    const bar = pressure[i];
    const commanded = target[i];
    if (at === undefined || bar === undefined || commanded === undefined) {
      return undefined;
    }
    return {
      time: normalizeValue(at, "timeInShot"),
      pressure: normalizeValue(bar, "pressure"),
      target: normalizeValue(commanded, "targetPressure"),
    };
  }).filter((sample) => sample !== undefined);
}

/**
 * The first sample at least `MIN_WINDOW_SEC` after `from`, if there is one.
 *
 * Never returns the series' final sample, deliberately. A shot ends when its
 * stop condition is met, the pump stops, and pressure releases — on real shots
 * at roughly twice the collapse threshold. That release is the shot finishing,
 * not the puck failing, and reporting it on every single shot is how a
 * diagnostic stops being read.
 */
function windowEnd(samples: Sample[], from: Sample): Sample | undefined {
  for (const candidate of samples.slice(0, -1)) {
    if (candidate.time - from.time >= MIN_WINDOW_SEC) return candidate;
  }
  return undefined;
}

/**
 * Windows where pressure fell fast while the profile was holding a target.
 *
 * Two gates before the rate is even computed, and both exist because a real
 * capture fails without them:
 *
 * - **The target must be commanded at both ends.** `targetPressure` is `0`
 *   while a profile drives flow — typically through a multi-second fill — and
 *   treating `0` as "a steady target of zero" turns the fill-to-extraction
 *   handover, where pressure genuinely drops fast, into a collapse on every
 *   such shot.
 * - **The target must not have moved.** When a profile commands a large
 *   mid-shot step, pressure follows it down fast; the machine did what it was
 *   told and nothing collapsed.
 *
 * Two more live in the loop body, because they need the measured pressure: the
 * fall must *begin* from a pressure that was tracking its target, and must
 * *end* below it.
 *
 * **The four overlap on purpose, and more than one will often reject the same
 * window.** Each states a different physical condition, and each is the only
 * one that catches some case: the tracking gate is what rejects a commanded
 * step whose decay undershoots the new target, and the target-moved gate is
 * what rejects a step that happens mid-window. Two are provably implied in the
 * steady-target regime — pressure is never negative, so a window with no
 * commanded target cannot end below it; and `TRACKING_MARGIN_BAR` is smaller
 * than the smallest detectable drop, so a tracked fall always ends below
 * target. Removing either on that basis would leave the moving-target cases
 * uncovered, which is why they are still here.
 */
function findFallingWindows(samples: Sample[]): PressureCollapse[] {
  const raw: PressureCollapse[] = [];

  for (const start of samples) {
    const end = windowEnd(samples, start);
    if (end === undefined) break;

    if (start.target <= 0 || end.target <= 0) continue;
    if (Math.abs(end.target - start.target) > TARGET_HELD_TOLERANCE_BAR) {
      continue;
    }

    // The fall must begin from a pressure that was *tracking* its target. A
    // puck that gives way does so from wherever the profile was holding it; a
    // machine still hauling pressure down after a commanded step is somewhere
    // well above the new target for the whole descent, and the descent can
    // undershoot below it before settling. That undershoot clears the
    // "ended below target" gate below, so this is the check that catches it.
    if (start.pressure > start.target + TRACKING_MARGIN_BAR) continue;

    // No divide-by-zero guard: `windowEnd` only ever returns a sample at least
    // `MIN_WINDOW_SEC` later, so this is >= 0.5 by construction.
    const elapsed = end.time - start.time;

    // Pressure must have ended up *below* what was commanded. Falling toward a
    // target is the machine obeying it: after a large step, pressure takes
    // seconds to decay onto the new target while the target holds steady, and
    // that decay can run uncomfortably close to the collapse rate — too little
    // margin to rest on the rate alone. Falling *past* the target is the thing
    // that has no benign explanation.
    if (end.pressure >= end.target) continue;

    const dropBar = start.pressure - end.pressure;
    if (dropBar / elapsed < COLLAPSE_BAR_PER_SEC) continue;

    raw.push({
      startSec: start.time,
      endSec: end.time,
      dropBar,
      targetBar: start.target,
    });
  }

  return raw;
}

/**
 * One event per collapse, not one per window that noticed it.
 *
 * A fall lasting a second trips every overlapping window along the way, and a
 * model handed nine events for one collapse will describe nine problems. Merged
 * windows report the full span and the total drop across it.
 */
function mergeOverlapping(windows: PressureCollapse[]): PressureCollapse[] {
  const merged: PressureCollapse[] = [];

  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous !== undefined && window.startSec <= previous.endSec) {
      previous.endSec = Math.max(previous.endSec, window.endSec);
      previous.dropBar = Math.max(previous.dropBar, window.dropBar);
      continue;
    }
    merged.push({ ...window });
  }

  return merged;
}

export function detectPressureCollapses(
  datapoints: ShotData["datapoints"],
): PressureCollapse[] {
  return mergeOverlapping(findFallingWindows(toSamples(datapoints)));
}

/** The observation, with its numbers, and no interpretation of them. */
export function describePressureCollapse(collapse: PressureCollapse): string {
  const elapsed = collapse.endSec - collapse.startSec;
  return [
    `pressure fell ${collapse.dropBar.toFixed(1)} bar`,
    `in ${elapsed.toFixed(1)}s`,
    `from ${collapse.startSec.toFixed(1)}s`,
    `while the target held at ${collapse.targetBar.toFixed(1)} bar`,
  ].join(" ");
}
