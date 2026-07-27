import { describe, expect, it } from "vitest";
import { buildShotContextSummary } from "./contextSummary";
import { type Annotation, type ShotMeta } from "./types";

const primary: ShotMeta = {
  duration: 32.4,
  id: "33",
  profileName: "Londinium",
  weight: 36.2,
};

const comparison: ShotMeta = {
  duration: 30.1,
  id: "32",
  profileName: "Londinium",
  weight: 34.8,
};

const annotations: Annotation[] = [
  {
    color: "",
    label: "First drip",
    metric: "firstDrip",
    time: 7.1,
    value: 0.6,
    yAxisId: "right",
  },
  {
    color: "",
    label: "9.3 bar",
    metric: "peakPressure",
    time: 16.3,
    value: 9.3,
    yAxisId: "left",
  },
];

const NONE_HIDDEN: ReadonlySet<string> = new Set();

describe("buildShotContextSummary", () => {
  it("names the shot and its key metrics", () => {
    const summary = buildShotContextSummary({
      annotations,
      hidden: NONE_HIDDEN,
      primary,
    });
    expect(summary).toContain("Shot #33 (Londinium): 36.2g in 32.4s");
    expect(summary).toContain("peak pressure 9.3 bar");
    expect(summary).toContain("first drip at 7.1s");
  });

  it("omits metrics the shot has no annotation for", () => {
    const summary = buildShotContextSummary({
      annotations: [],
      hidden: NONE_HIDDEN,
      primary,
    });
    expect(summary).not.toContain("peak pressure");
    expect(summary).not.toContain("first drip");
  });

  it("does not mention a comparison when there is none", () => {
    const summary = buildShotContextSummary({
      annotations,
      hidden: NONE_HIDDEN,
      primary,
    });
    expect(summary).not.toContain("Overlaid");
  });

  it("describes an overlaid comparison shot", () => {
    const summary = buildShotContextSummary({
      annotations,
      comparison,
      comparisonAnnotations: [],
      hidden: NONE_HIDDEN,
      primary,
    });
    expect(summary).toContain("Overlaid for comparison — Shot #32 (Londinium)");
  });

  it("lists every series when nothing is hidden", () => {
    const summary = buildShotContextSummary({
      annotations,
      hidden: NONE_HIDDEN,
      primary,
    });
    expect(summary).toContain(
      "Series currently plotted: pressure, flow, weight flow, weight.",
    );
  });

  it("separates hidden series from plotted ones", () => {
    const summary = buildShotContextSummary({
      annotations,
      hidden: new Set(["pressure", "weightFlow"]),
      primary,
    });
    expect(summary).toContain("Series currently plotted: flow, weight.");
    expect(summary).toContain("Hidden by the user: pressure, weight flow.");
  });

  it("says so when every series is hidden", () => {
    const summary = buildShotContextSummary({
      annotations,
      hidden: new Set(["pressure", "pumpFlow", "shotWeight", "weightFlow"]),
      primary,
    });
    expect(summary).toContain("The user has hidden every series.");
    expect(summary).not.toContain("Hidden by the user");
  });
});
