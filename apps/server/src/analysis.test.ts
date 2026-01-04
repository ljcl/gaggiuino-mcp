import { describe, expect, it } from "vitest";
import {
  mockShotData,
  mockShotEmptyDatapoints,
  mockShotNoTargetWeight,
  mockShotWithTempDrift,
} from "./__fixtures__/api-responses";
import {
  extractOutcomeMetrics,
  formatShotSummary,
  generateShotSummary,
  normalizeValue,
} from "./analysis";

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

  it("shows target weight comparison when available", () => {
    const summary = generateShotSummary(mockShotData);
    const text = formatShotSummary(summary);

    expect(text).toContain("target: 38g");
  });

  it("shows weight without target when not available", () => {
    const summary = generateShotSummary(mockShotNoTargetWeight);
    const text = formatShotSummary(summary);

    expect(text).toContain("Final Weight: 38.1g");
    expect(text).not.toContain("target:");
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

describe("generateShotSummary edge cases", () => {
  it("returns empty phases for shot with no time data", () => {
    const summary = generateShotSummary(mockShotEmptyDatapoints);
    expect(summary.phases).toEqual([]);
  });
});
