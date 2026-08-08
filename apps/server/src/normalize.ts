/**
 * The machine's wire format, and the one place it is undone.
 *
 * Gaggiuino sends its shot time-series as integers scaled by ten — pressure 91
 * means 9.1 bar, `timeInShot` 350 means 35.0 seconds. Anything reading raw
 * datapoints has to divide, and every module that decided to divide for itself
 * is a module that can disagree about which fields are scaled.
 *
 * Note this is the *time-series* convention only. A profile definition
 * (`profileShape.ts`) uses the opposite one: real units, milliseconds, degrees.
 */

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
