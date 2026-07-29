import { describe, expect, it } from "vitest";
import { londiniumShot33, quickShot } from "./__fixtures__/chart-data";
import { derivePhaseRegions } from "./phases";
import { type ShotData } from "./types";

/** Minimal shot with hand-placed target transitions. Times in 10ths of a second. */
function shot(
  overrides: {
    phases?: Array<{ type: string }>;
    targetPressure?: number[];
    targetPumpFlow?: number[];
    timeInShot?: number[];
  } = {},
): ShotData {
  const {
    phases = [{ type: "FLOW" }, { type: "PRESSURE" }],
    targetPressure = [],
    targetPumpFlow = [],
    timeInShot = [0, 10, 20, 30, 40],
  } = overrides;
  return {
    datapoints: { targetPressure, targetPumpFlow, timeInShot },
    duration: (timeInShot.at(-1) ?? 0) as number,
    id: "1",
    profile: { name: "Test", phases },
  };
}

describe("derivePhaseRegions", () => {
  it("labels each region from the profile's phase type", () => {
    const regions = derivePhaseRegions(
      shot({ targetPumpFlow: [30, 30, 0, 0, 0] }),
    );
    expect(regions.map((r) => r.label)).toEqual(["Flow", "Pressure"]);
  });

  it("spans the whole shot with contiguous regions", () => {
    const regions = derivePhaseRegions(
      shot({ targetPumpFlow: [30, 30, 0, 0, 0] }),
    );
    expect(regions).toEqual([
      { end: 2, index: 0, label: "Flow", start: 0 },
      { end: 4, index: 1, label: "Pressure", start: 2 },
    ]);
  });

  it("never returns more regions than the profile declares phases", () => {
    // Four pressure steps, but a single-phase profile: no internal boundary
    // survives, because the profile says the shot has one phase.
    const regions = derivePhaseRegions(
      shot({
        phases: [{ type: "PRESSURE" }],
        targetPressure: [0, 90, 20, 90, 20],
      }),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({
      end: 4,
      index: 0,
      label: "Pressure",
      start: 0,
    });
  });

  it("keeps the strongest transitions when the targets offer too many", () => {
    // Three steps of increasing size; a two-phase profile keeps only the last.
    const regions = derivePhaseRegions(
      shot({
        targetPressure: [0, 20, 50, 90, 90],
        timeInShot: [0, 10, 20, 30, 40],
      }),
    );
    expect(regions.map((r) => r.start)).toEqual([0, 3]);
  });

  it("prefers a flow handover over any pressure step", () => {
    const regions = derivePhaseRegions(
      shot({
        // Index 1 is a huge pressure step; index 3 is the flow target ending.
        targetPressure: [0, 90, 90, 90, 90],
        targetPumpFlow: [30, 30, 30, 0, 0],
      }),
    );
    expect(regions.map((r) => r.start)).toEqual([0, 3]);
  });

  it("yields fewer regions than phases when the targets show no transition", () => {
    const regions = derivePhaseRegions(
      shot({ targetPressure: [90, 90, 90, 90, 90] }),
    );
    expect(regions.map((r) => r.label)).toEqual(["Flow"]);
  });

  it("draws nothing when the profile names no phases", () => {
    expect(
      derivePhaseRegions(
        shot({ phases: [], targetPumpFlow: [30, 0, 0, 0, 0] }),
      ),
    ).toEqual([]);
  });

  it("draws nothing when the shot has no datapoints", () => {
    expect(derivePhaseRegions(shot({ timeInShot: [] }))).toEqual([]);
  });

  it("falls back to a positional label for an unnamed phase", () => {
    const regions = derivePhaseRegions(
      shot({ phases: [{ type: "" }], targetPressure: [90, 90, 90, 90, 90] }),
    );
    expect(regions.map((r) => r.label)).toEqual(["Phase 1"]);
  });

  it("prettifies multi-word phase types", () => {
    const regions = derivePhaseRegions(
      shot({
        phases: [{ type: "SOAK_AND_RAMP" }],
        targetPressure: [90, 90, 90, 90, 90],
      }),
    );
    expect(regions.map((r) => r.label)).toEqual(["Soak and ramp"]);
  });

  it("splits a real two-phase shot at the fill/extraction handover", () => {
    const regions = derivePhaseRegions(londiniumShot33);
    expect(regions.map((r) => r.label)).toEqual(["Flow", "Pressure"]);
    // The Londinium profile fills for the first few seconds, then extracts to
    // the end of the 29.2s shot.
    expect(regions[0]?.start).toBe(0.2);
    expect(regions[1]?.end).toBe(29.2);
    expect(regions[0]?.end).toBe(regions[1]?.start);
  });

  it("returns one region for a single-phase profile", () => {
    expect(derivePhaseRegions(quickShot).map((r) => r.label)).toEqual([
      "Pressure",
    ]);
  });
});
