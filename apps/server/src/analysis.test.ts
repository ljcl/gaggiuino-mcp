import {
  londiniumShot32,
  londiniumShot33,
} from "@gaggiuino/shot-graph/fixtures";
import { derivePhaseRegions } from "@gaggiuino/shot-graph/phases";
import { describe, expect, it } from "vitest";
import {
  mockShotData,
  mockShotEmptyDatapoints,
  mockShotNoTargetWeight,
  mockShotWithTempDrift,
} from "./__fixtures__/api-responses";
import {
  extractOutcomeMetrics,
  formatOutcomeMetrics,
  formatShotSummary,
  generateShotSummary,
} from "./analysis";
import { ShotDataSchema } from "./client";
import { normalizeValue } from "./normalize";

describe("normalizeValue", () => {
  it("divides pressure by 10", () => {
    expect(normalizeValue(91, "pressure")).toBe(9.1);
  });

  it("divides temperature by 10", () => {
    expect(normalizeValue(910, "temperature")).toBe(91.0);
  });

  it("divides pumpFlow by 10", () => {
    expect(normalizeValue(25, "pumpFlow")).toBe(2.5);
  });

  it("divides shotWeight by 10", () => {
    expect(normalizeValue(381, "shotWeight")).toBe(38.1);
  });

  it("divides timeInShot by 10", () => {
    expect(normalizeValue(340, "timeInShot")).toBe(34.0);
  });

  it("returns value unchanged for unknown fields", () => {
    expect(normalizeValue(5, "someOtherField")).toBe(5);
  });
});

describe("extractOutcomeMetrics", () => {
  it("extracts shot ID", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.shotId).toBe("1706547890");
  });

  it("extracts profile name", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.profileName).toBe("LMD 9-8 v1.5 (milk)");
  });

  it("normalizes duration to seconds", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.totalDurationSec).toBe(34.0);
  });

  it("extracts final weight normalized", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.finalWeightG).toBe(38.1);
  });

  it("extracts peak pressure normalized", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.peakPressureBar).toBe(9.1);
  });

  it("extracts water pumped normalized", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.waterPumpedMl).toBe(54.7);
  });

  it("detects time to first drip", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.timeToFirstDripSec).toBe(20.0);
  });

  it("ignores tare noise the scale opened the shot with", () => {
    // Condensed from live shot #362 (2026-08-13): the scale read 0.8g at the
    // first sample — residual water, not coffee — decayed to zero, and only
    // rose for real much later. Taking any sample above 0.5g reported first
    // drip at 0.3s on that shot.
    const shot = {
      ...mockShotData,
      datapoints: {
        ...mockShotData.datapoints,
        timeInShot: [3, 5, 6, 40, 80, 100, 106, 140, 210],
        shotWeight: [8, 8, 6, 0, 4, 5, 7, 20, 102],
      },
    };
    const metrics = extractOutcomeMetrics(shot);
    expect(metrics.timeToFirstDripSec).toBe(10.6);
  });

  it("reports no first drip when the scale never settles below the threshold", () => {
    // A reading that was above 0.5g before anything could have reached the cup
    // is tare, and a tare that never clears leaves nothing to date a drip from.
    const shot = {
      ...mockShotData,
      datapoints: {
        ...mockShotData.datapoints,
        timeInShot: [3, 5, 6, 40],
        shotWeight: [8, 9, 12, 30],
      },
    };
    const metrics = extractOutcomeMetrics(shot);
    expect(metrics.timeToFirstDripSec).toBeNull();
  });

  it("detects stable temperature", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.tempStability).toBe("stable");
  });

  it("extracts target weight from globalStopConditions", () => {
    const metrics = extractOutcomeMetrics(mockShotData);
    expect(metrics.targetWeightG).toBe(38);
  });
});

describe("generateShotSummary", () => {
  it("includes outcome metrics", () => {
    const summary = generateShotSummary(mockShotData);
    expect(summary.outcomeMetrics.shotId).toBe("1706547890");
  });

  it("includes phases array", () => {
    const summary = generateShotSummary(mockShotData);
    expect(Array.isArray(summary.phases)).toBe(true);
  });
});

describe("formatShotSummary", () => {
  it("formats summary as readable string", () => {
    const summary = generateShotSummary(mockShotData);
    const text = formatShotSummary(summary);

    expect(text).toContain("Shot #1706547890");
    expect(text).toContain("LMD 9-8 v1.5 (milk)");
    expect(text).toContain("Duration:");
    expect(text).toContain("Final Weight:");
  });

  it("renders a phase's events under it", () => {
    // `events` is always empty today — `extractPhaseSummary` is the thing that
    // will start filling it. The renderer is already here and already
    // advertised, so it is asserted here rather than left for whoever does.
    const summary = generateShotSummary(mockShotData);
    const [first] = summary.phases;
    if (first === undefined) throw new Error("expected at least one phase");
    first.events = ["pressure fell 2.3 bar in 0.4s at 12.1s"];

    const text = formatShotSummary(summary);

    expect(text).toContain("  Events:");
    expect(text).toContain("    - pressure fell 2.3 bar in 0.4s at 12.1s");
  });

  it("shows target weight comparison when available", () => {
    const summary = generateShotSummary(mockShotData);
    const text = formatShotSummary(summary);

    expect(text).toContain("target: 38g");
  });

  it("shows weight without target when not available", () => {
    const summary = generateShotSummary(mockShotNoTargetWeight);
    const text = formatShotSummary(summary);

    expect(text).toContain("Final Weight: 38.1g");
    // Scoped to the weight line rather than the whole block: other lines
    // legitimately mention a target, so a bare "target:" search would pass or
    // fail for reasons that have nothing to do with the weight.
    expect(text).not.toMatch(/Final Weight:.*target/);
  });
});

describe("extractOutcomeMetrics edge cases", () => {
  it("detects temperature drift > 1°C", () => {
    const metrics = extractOutcomeMetrics(mockShotWithTempDrift);
    expect(metrics.tempStability).toContain("drifted");
  });

  it("handles empty datapoints gracefully", () => {
    const metrics = extractOutcomeMetrics(mockShotEmptyDatapoints);
    expect(metrics.totalDurationSec).toBe(0);
    expect(metrics.finalWeightG).toBe(0);
    expect(metrics.peakPressureBar).toBe(0);
  });

  it("returns null targetWeight when not set", () => {
    const metrics = extractOutcomeMetrics(mockShotNoTargetWeight);
    expect(metrics.targetWeightG).toBeNull();
  });
});

describe("deviation from the profile's own targets", () => {
  it("measures pressure against the target on a real tapering shot", () => {
    // Londinium lowers its target 8.8 bar -> 6.3 across the shot, so a fixed
    // band would call this shot wrong for tracking it correctly. Measured
    // against its own target it runs ~1 bar under, consistently.
    const m33 = extractOutcomeMetrics(ShotDataSchema.parse(londiniumShot33));
    const m32 = extractOutcomeMetrics(ShotDataSchema.parse(londiniumShot32));

    expect(m33.pressureDeviationBar).toBeCloseTo(0.99, 1);
    expect(m32.pressureDeviationBar).toBeCloseTo(1.12, 1);
  });

  it("ignores the samples where the profile commanded no pressure target", () => {
    // Londinium drives flow for its first five seconds with targetPressure 0.
    // Counting those as "asked for 0 bar, got 4" would swamp the answer.
    const shot = ShotDataSchema.parse(londiniumShot33);
    const uncommanded = (shot.datapoints.targetPressure ?? []).filter(
      (v) => v <= 0,
    ).length;

    expect(uncommanded).toBeGreaterThan(0);
    // 65 of 191 samples are uncommanded; including them would push the mean
    // well past 1 bar rather than leaving it just under.
    expect(extractOutcomeMetrics(shot).pressureDeviationBar).toBeLessThan(1.5);
  });

  it("reports null when the shot record carries no target for the metric", () => {
    // Neither captured shot records targetTemperature at all.
    const metrics = extractOutcomeMetrics(
      ShotDataSchema.parse(londiniumShot33),
    );

    expect(metrics.tempDeviationC).toBeNull();
    expect(formatOutcomeMetrics(metrics)).not.toContain("off target");
  });

  it("measures temperature against a commanded target", () => {
    const shot = {
      ...mockShotData,
      datapoints: {
        ...mockShotData.datapoints,
        temperature: [930, 940, 950, 960, 950],
        targetTemperature: [950, 950, 950, 950, 950],
      },
    };

    // |93-95| + |94-95| + 0 + |96-95| + 0, over five samples.
    expect(extractOutcomeMetrics(shot).tempDeviationC).toBeCloseTo(0.8, 5);
  });

  it("separates a steady-but-wrong boiler from a wobbling one", () => {
    // The case the spread cannot see: held rock steady, three degrees cold.
    const shot = {
      ...mockShotData,
      datapoints: {
        ...mockShotData.datapoints,
        temperature: [920, 920, 920, 920, 920],
        targetTemperature: [950, 950, 950, 950, 950],
      },
    };
    const metrics = extractOutcomeMetrics(shot);

    expect(metrics.tempStability).toBe("stable");
    expect(metrics.tempDeviationC).toBeCloseTo(3, 5);
    expect(formatOutcomeMetrics(metrics)).toContain("stable, 3.0C off target");
  });
});

describe("generateShotSummary edge cases", () => {
  it("returns empty phases for shot with no time data", () => {
    const summary = generateShotSummary(mockShotEmptyDatapoints);
    expect(summary.phases).toEqual([]);
  });
});

/**
 * The chart and `get_shot_data` are two implementations of one rule, in two
 * packages that cannot share a module (there is no `shared-data` tag — see
 * AGENTS.md, "Turborepo"). These assertions are what keeps them one rule.
 *
 * They run against `londiniumShot33`/`32` — ~190 and ~170 samples captured off a
 * real machine — rather than `mockShotData`'s five points at ten-second spacing,
 * because the divergence they pin was invisible at that resolution.
 */
describe("phase segmentation agrees with the chart", () => {
  const capturedShots = [
    ["londiniumShot33", londiniumShot33],
    ["londiniumShot32", londiniumShot32],
  ] as const;

  for (const [name, shot] of capturedShots) {
    // Through the client's own boundary schema, not straight into the analysis
    // functions. It is what the machine's payload has to survive in production,
    // so a captured fixture that could not survive it would be a fixture of
    // something the server never actually sees.
    const parsed = ShotDataSchema.parse(shot);

    it(`${name}: same phase count and boundaries as derivePhaseRegions`, () => {
      const { phases } = generateShotSummary(parsed);
      const regions = derivePhaseRegions(shot);

      expect(phases).toHaveLength(regions.length);
      expect(phases.map((phase) => phase.durationSec)).toEqual(
        regions.map((region) => region.end - region.start),
      );
    });

    it(`${name}: names the profile's own two phases, none of them empty`, () => {
      const { phases } = generateShotSummary(parsed);

      expect(phases.map((phase) => phase.type)).toEqual(["FLOW", "PRESSURE"]);
      for (const phase of phases) {
        expect(phase.durationSec).toBeGreaterThan(0);
      }
    });
  }

  it("keeps only the strongest boundaries a two-phase profile has room for", () => {
    // Three pressure steps over 10 raw units, but the profile names two phases,
    // so only the largest survives. Before the cap this returned four phases,
    // the last two typed "UNKNOWN".
    const { phases } = generateShotSummary(mockShotData);

    expect(phases).toHaveLength(2);
    expect(phases.map((phase) => phase.type)).toEqual(["FLOW", "PRESSURE"]);
  });

  it("finds a transition after the pressure target stops being reported", () => {
    // targetPumpFlow outlives targetPressure. Bounding the walk by
    // targetPressure alone missed the flow handover at index 3 entirely.
    const shot = {
      ...mockShotData,
      datapoints: {
        ...mockShotData.datapoints,
        targetPressure: [20, 20],
        targetPumpFlow: [40, 40, 40, 0, 0],
      },
    };

    const { phases } = generateShotSummary(shot);

    expect(phases).toHaveLength(2);
    expect(phases[1]?.durationSec).toBeGreaterThan(0);
  });

  it("falls back to UNKNOWN for a phase the firmware sent without a type", () => {
    const shot = {
      ...mockShotData,
      profile: {
        ...mockShotData.profile,
        phases: [{ stopConditions: { time: 5000 } }, { type: "PRESSURE" }],
      },
    };

    expect(generateShotSummary(shot).phases.map((phase) => phase.type)).toEqual(
      ["UNKNOWN", "PRESSURE"],
    );
  });

  it("returns phases in time order when the strongest boundary comes last", () => {
    // Candidates are ranked by strength to decide which survive the cap, then
    // put back in time order. Here the later boundary is the stronger one
    // (90 raw units vs 40), so ranking alone would emit them backwards.
    const shot = {
      id: "42",
      duration: 300,
      datapoints: {
        timeInShot: [0, 50, 100, 150, 200, 250, 300],
        targetPressure: [20, 20, 60, 60, 60, 150, 150],
        targetPumpFlow: [40, 40, 40, 40, 40, 40, 40],
        pressure: [18, 21, 58, 61, 60, 148, 149],
        pumpFlow: [40, 38, 30, 28, 26, 20, 18],
        shotWeight: [0, 0, 20, 60, 110, 180, 240],
      },
      profile: {
        name: "Three phases",
        phases: [{ type: "FLOW" }, { type: "PRESSURE" }, { type: "DECLINE" }],
      },
    };

    const { phases } = generateShotSummary(shot);

    expect(phases.map((phase) => phase.type)).toEqual([
      "FLOW",
      "PRESSURE",
      "DECLINE",
    ]);
    // Strictly increasing, and abutting: 0-10s, 10-25s, 25-30s.
    expect(phases.map((phase) => phase.durationSec)).toEqual([10, 15, 5]);
  });

  it("survives a target series that outlives the time series", () => {
    // The upstream boundary schema requires neither series to match the other's
    // length, and this firmware is documented to disagree with itself about
    // shapes. A boundary past the end of `timeInShot` must not throw or emit
    // NaN — it reads as time zero, which is what the guards in the mapper do.
    const shot = {
      id: "43",
      duration: 200,
      datapoints: {
        timeInShot: [0, 100, 200],
        targetPressure: [20, 20, 20, 20, 90, 90],
        targetPumpFlow: [40, 40, 40, 40, 40, 40],
        pressure: [18, 21, 19],
        pumpFlow: [40, 38, 30],
        shotWeight: [0, 10, 40],
      },
      profile: {
        name: "Ragged",
        phases: [{ type: "FLOW" }, { type: "PRESSURE" }],
      },
    };

    const { phases } = generateShotSummary(shot);

    expect(phases).toHaveLength(2);
    for (const phase of phases) {
      expect(Number.isFinite(phase.durationSec)).toBe(true);
    }
  });

  it("leaves events empty for the real captured shots", () => {
    for (const shot of [londiniumShot33, londiniumShot32]) {
      const { phases } = generateShotSummary(ShotDataSchema.parse(shot));
      expect(phases.flatMap((phase) => phase.events)).toEqual([]);
    }
  });

  it("attributes a collapse to the phase it started in, exactly once", () => {
    // 9 bar held through a two-phase profile, then 3 bar lost in ~0.9s well
    // inside the second phase.
    const pressure = [
      9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 8.4, 7.6, 6.8, 6.2, 6, 6, 6, 6,
    ];
    const shot = {
      id: "44",
      duration: Math.round((10 + (pressure.length - 1) * 0.15) * 10),
      datapoints: {
        timeInShot: pressure.map((_, i) => Math.round((10 + i * 0.15) * 10)),
        pressure: pressure.map((v) => Math.round(v * 10)),
        // A flow handover at index 5 is the only boundary, so the collapse at
        // index 10 lands unambiguously inside phase 2.
        targetPressure: pressure.map(() => 90),
        targetPumpFlow: pressure.map((_, i) => (i < 5 ? 20 : 0)),
        shotWeight: pressure.map((_, i) => i * 10),
        pumpFlow: pressure.map(() => 20),
      },
      profile: {
        name: "Collapse",
        phases: [{ type: "FLOW" }, { type: "PRESSURE" }],
      },
    };

    const summary = generateShotSummary(shot);
    const all = summary.phases.flatMap((phase) => phase.events);

    expect(all).toHaveLength(1);
    expect(summary.phases[1]?.events).toEqual(all);
    expect(all[0]).toMatch(
      /^pressure fell \d+\.\d bar in \d+\.\ds from \d+\.\ds while the target held at 9\.0 bar$/,
    );
    // The prose block renders it under its phase.
    const text = formatShotSummary(summary);
    expect(text).toContain("  Events:");
    expect(text).toContain(`    - ${all[0]}`);
  });

  it("reports no phases, and says so, when the profile names none", () => {
    const shot = { ...mockShotData, profile: { name: "Manual" } };
    const summary = generateShotSummary(shot);

    expect(summary.phases).toEqual([]);
    expect(formatShotSummary(summary)).toContain(
      "Not available: this shot's profile does not name any phases.",
    );
  });
});
