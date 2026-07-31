import { describe, expect, it } from "vitest";
import { londiniumShot32, londiniumShot33 } from "./__fixtures__/chart-data";
import { extractAnnotations, extractMeta, toChartData } from "./normalize";
import { type ShotData, type ShotDatapoints } from "./types";

/**
 * The machine sends every value scaled by ten, times included — 91 is 9.1 bar
 * and 350 is 35.0s. Everything below is written in those raw units, because
 * that is what arrives and the divide is the thing under test: an off-by-ten
 * here draws a plausible-looking wrong chart that no story smoke test catches.
 */
function shot(
  datapoints: ShotDatapoints,
  overrides: Partial<Omit<ShotData, "datapoints">> = {},
): ShotData {
  return {
    duration: 300,
    id: "1",
    profile: { name: "Test", phases: [] },
    ...overrides,
    datapoints,
  };
}

/** A series with a hole in it, which is what a truncated response looks like. */
function sparse(values: (number | undefined)[]): number[] {
  return values as number[];
}

describe("extractMeta", () => {
  it("scales duration and the final weight down by ten", () => {
    expect(
      extractMeta(shot({ shotWeight: [0, 180, 361] }, { duration: 292 })),
    ).toEqual({
      duration: 29.2,
      id: "1",
      profileName: "Test",
      weight: 36.1,
    });
  });

  it("reports zero weight when the shot carries no scale data", () => {
    expect(extractMeta(shot({})).weight).toBe(0);
  });

  it("reports zero weight when the weight series is empty", () => {
    expect(extractMeta(shot({ shotWeight: [] })).weight).toBe(0);
  });

  it("falls back to Unknown for a profile the machine did not name", () => {
    // `name` is non-optional in ShotProfile, but the app parses whatever the
    // firmware sends; the fallback exists for the response that omits it.
    const unnamed = shot({}, { profile: { phases: [] } as never });
    expect(extractMeta(unnamed).profileName).toBe("Unknown");
  });

  it("reads a real shot's header off the fixture", () => {
    expect(extractMeta(londiniumShot33)).toEqual({
      duration: 29.2,
      id: londiniumShot33.id,
      profileName: "Londinium",
      weight: 37.6,
    });
  });
});

describe("toChartData", () => {
  it("divides every series by ten and keys each row on its time", () => {
    const data = toChartData(
      shot({
        pressure: [0, 91],
        pumpFlow: [50, 22],
        shotWeight: [0, 361],
        targetPressure: [90, 90],
        targetPumpFlow: [40, 0],
        temperature: [930, 928],
        timeInShot: [0, 105],
        weightFlow: [0, 18],
      }),
    );
    expect(data).toEqual([
      {
        pressure: 0,
        pumpFlow: 5,
        shotWeight: 0,
        targetPressure: 9,
        targetPumpFlow: 4,
        temperature: 93,
        time: 0,
        weightFlow: 0,
      },
      {
        pressure: 9.1,
        pumpFlow: 2.2,
        shotWeight: 36.1,
        targetPressure: 9,
        targetPumpFlow: 0,
        temperature: 92.8,
        time: 10.5,
        weightFlow: 1.8,
      },
    ]);
  });

  it("leaves a series the machine did not send undefined", () => {
    const [point] = toChartData(shot({ pressure: [91], timeInShot: [10] }));
    expect(point).toEqual({ pressure: 9.1, time: 1 });
  });

  it("leaves a hole in a series undefined rather than plotting zero", () => {
    // `0 / 10` is a legitimate reading; `undefined / 10` is NaN. Neither is
    // what a missing sample means, so the value has to stay absent.
    const data = toChartData(
      shot({
        pressure: sparse([91, undefined, 20]),
        timeInShot: [0, 10, 20],
      }),
    );
    expect(data.map((p) => p.pressure)).toEqual([9.1, undefined, 2]);
  });

  it("returns nothing when the shot has no time axis", () => {
    expect(toChartData(shot({ pressure: [91] }))).toEqual([]);
  });

  it("skips a datapoint whose timestamp is missing", () => {
    // Without the guard the row would be keyed on NaN, and every such row
    // would collide into one.
    const data = toChartData(
      shot({
        pressure: [91, 90, 20],
        timeInShot: sparse([0, undefined, 20]),
      }),
    );
    expect(data.map((p) => p.time)).toEqual([0, 2]);
  });

  it("sorts rows by time regardless of the order they arrived in", () => {
    const data = toChartData(
      shot({ pressure: [20, 91, 50], timeInShot: [200, 0, 100] }),
    );
    expect(data.map((p) => p.time)).toEqual([0, 10, 20]);
  });

  describe("with a comparison shot", () => {
    it("merges a comparison sample into the row sharing its timestamp", () => {
      const data = toChartData(
        shot({ pressure: [91], timeInShot: [100] }),
        shot({ pressure: [80], timeInShot: [100] }),
      );
      expect(data).toEqual([{ pressure: 9.1, pressureCmp: 8, time: 10 }]);
    });

    it("adds a row for a timestamp only the comparison reached", () => {
      // Shots are rarely the same length; the longer one has to keep drawing
      // past the end of the shorter, not be truncated to it.
      const data = toChartData(
        shot({ pressure: [91], timeInShot: [100] }),
        shot({ pressure: [80, 70], timeInShot: [100, 200] }),
      );
      expect(data).toEqual([
        { pressure: 9.1, pressureCmp: 8, time: 10 },
        { pressureCmp: 7, time: 20 },
      ]);
    });

    it("scales every comparison series by ten too", () => {
      const [point] = toChartData(
        shot({ timeInShot: [0] }),
        shot({
          pressure: [91],
          pumpFlow: [22],
          shotWeight: [361],
          targetPressure: [90],
          targetPumpFlow: [40],
          temperature: [928],
          timeInShot: [0],
          weightFlow: [18],
        }),
      );
      expect(point).toEqual({
        pressureCmp: 9.1,
        pumpFlowCmp: 2.2,
        shotWeightCmp: 36.1,
        targetPressureCmp: 9,
        targetPumpFlowCmp: 4,
        temperatureCmp: 92.8,
        time: 0,
        weightFlowCmp: 1.8,
      });
    });

    it("skips a comparison datapoint whose timestamp is missing", () => {
      const data = toChartData(
        shot({ pressure: [91], timeInShot: [0] }),
        shot({ pressure: [80, 70], timeInShot: sparse([undefined, 100]) }),
      );
      expect(data.map((p) => p.time)).toEqual([0, 10]);
      expect(data[0]?.pressureCmp).toBeUndefined();
    });

    it("keeps a comparison with no time axis from disturbing the primary", () => {
      const data = toChartData(
        shot({ pressure: [91], timeInShot: [0] }),
        shot({ pressure: [80] }),
      );
      expect(data).toEqual([{ pressure: 9.1, time: 0 }]);
    });

    it("overlays two real shots on one time axis", () => {
      const data = toChartData(londiniumShot33, londiniumShot32);
      const overlaid = data.filter((p) => p.pressureCmp !== undefined);
      expect(overlaid.length).toBeGreaterThan(0);
      expect(data).toEqual([...data].sort((a, b) => a.time - b.time));
    });
  });
});

describe("extractAnnotations", () => {
  it("marks first drip at the first sample above 0.5g", () => {
    const [firstDrip] = extractAnnotations(
      shot({
        shotWeight: [0, 3, 5, 12, 40],
        timeInShot: [0, 10, 20, 30, 40],
      }),
    );
    // 5 is not above 5 — the threshold is raw `> 5`, i.e. strictly past 0.5g.
    expect(firstDrip).toEqual({
      color: "var(--chart-weight)",
      label: "First drip",
      metric: "firstDrip",
      time: 3,
      value: 1.2,
      yAxisId: "right",
    });
  });

  it("marks no first drip when the shot never reached 0.5g", () => {
    const annotations = extractAnnotations(
      shot({ shotWeight: [0, 1, 2], timeInShot: [0, 10, 20] }),
    );
    expect(annotations.map((a) => a.metric)).not.toContain("firstDrip");
  });

  it("marks no first drip when the machine has no scale attached", () => {
    const annotations = extractAnnotations(
      shot({ pressure: [91], timeInShot: [0] }),
    );
    expect(annotations.map((a) => a.metric)).toEqual(["peakPressure"]);
  });

  it("marks peak pressure at the maximum, labelled to one decimal", () => {
    const [peak] = extractAnnotations(
      shot({ pressure: [10, 93, 91, 20], timeInShot: [0, 10, 20, 30] }),
    );
    expect(peak).toEqual({
      color: "var(--chart-pressure)",
      label: "9.3 bar",
      metric: "peakPressure",
      time: 1,
      value: 9.3,
      yAxisId: "left",
    });
  });

  it("keeps the first of two equal peaks", () => {
    const [peak] = extractAnnotations(
      shot({ pressure: [91, 91], timeInShot: [0, 10] }),
    );
    expect(peak?.time).toBe(0);
  });

  it("marks no peak when the pressure series is empty", () => {
    expect(extractAnnotations(shot({ pressure: [], timeInShot: [0] }))).toEqual(
      [],
    );
  });

  it("marks no peak when the pressure series is a hole", () => {
    // Every sample undefined: `maxVal` never moves off -1, so there is no
    // index to annotate and -0.1 bar must not be drawn.
    expect(
      extractAnnotations(
        shot({ pressure: sparse([undefined]), timeInShot: [0] }),
      ),
    ).toEqual([]);
  });

  it("marks nothing at all when the shot has no time axis", () => {
    expect(
      extractAnnotations(shot({ pressure: [91], shotWeight: [40] })),
    ).toEqual([]);
  });

  it("marks no peak when the time axis stops short of the maximum", () => {
    // A truncated response: pressure peaks at an index the time axis never
    // reached, so there is no x-coordinate to place the dot at.
    expect(
      extractAnnotations(shot({ pressure: [10, 91], timeInShot: [0] })),
    ).toEqual([]);
  });

  it("annotates a real shot with both metrics, first drip first", () => {
    expect(extractAnnotations(londiniumShot33).map((a) => a.metric)).toEqual([
      "firstDrip",
      "peakPressure",
    ]);
  });
});
