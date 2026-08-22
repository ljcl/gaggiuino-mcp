import { describe, expect, it } from "vitest";
import { describeChart, describePressureFlowPlot } from "./a11y";
import { type Annotation, type ChartDataPoint, type ShotMeta } from "./types";

const PRIMARY: ShotMeta = {
  duration: 32.4,
  id: "412",
  profileName: "Londinium",
  weight: 36.2,
};

const DATA: ChartDataPoint[] = [
  { pressure: 2.1, pumpFlow: 4.4, shotWeight: 0, time: 0, weightFlow: 0 },
  { pressure: 9.1, pumpFlow: 2.2, shotWeight: 8.4, time: 12, weightFlow: 1.9 },
  { pressure: 6.4, pumpFlow: 1.8, shotWeight: 36.2, time: 32, weightFlow: 1.1 },
];

describe("describeChart", () => {
  it("names the profile in the title", () => {
    expect(describeChart({ data: DATA, primary: PRIMARY }).title).toBe(
      "Espresso shot graph: Londinium",
    );
  });

  it("opens with the shot's duration and yield", () => {
    const { desc } = describeChart({ data: DATA, primary: PRIMARY });
    expect(desc).toContain("32.4 seconds");
    expect(desc).toContain("36.2 grams");
  });

  it("reports each series' peak with its own unit", () => {
    const { desc } = describeChart({ data: DATA, primary: PRIMARY });
    expect(desc).toContain("pressure 9.1 bar at 12 seconds");
    expect(desc).toContain("flow 4.4 ml/s at 0 seconds");
    expect(desc).toContain("weight flow 1.9 g/s at 12 seconds");
    expect(desc).toContain("weight 36.2 g at 32 seconds");
  });

  it("drops trailing zeroes so the narration reads naturally", () => {
    const { desc } = describeChart({
      data: [{ pressure: 9, shotWeight: 30, time: 0 }],
      primary: { ...PRIMARY, duration: 30, weight: 30 },
    });
    expect(desc).toContain("30 seconds");
    expect(desc).not.toContain("30.0");
  });

  it("skips a series the shot never recorded", () => {
    const { desc } = describeChart({
      data: [{ pressure: 9.1, time: 0 }],
      primary: PRIMARY,
    });
    expect(desc).toContain("pressure 9.1 bar");
    expect(desc).not.toContain("weight flow 1.9");
  });

  it("lists annotation labels as marked points", () => {
    const annotations: Annotation[] = [
      {
        color: "red",
        label: "Peak 9.1 bar",
        metric: "peakPressure",
        time: 12,
        value: 9.1,
        yAxisId: "left",
      },
    ];
    const { desc } = describeChart({
      annotations,
      data: DATA,
      primary: PRIMARY,
    });
    expect(desc).toContain("Marked points: Peak 9.1 bar.");
  });

  // The comparison is the reason someone opens this chart twice; a description
  // that renders the overlay but never says which shot won is not much use.
  it("states the direction of the comparison, not just both numbers", () => {
    const { desc, title } = describeChart({
      comparison: {
        ...PRIMARY,
        duration: 28.4,
        id: "411",
        profileName: "Turbo",
        weight: 30.2,
      },
      data: DATA,
      primary: PRIMARY,
    });
    expect(title).toBe("Espresso shot graph: Londinium compared with Turbo");
    expect(desc).toContain("6 grams more");
    expect(desc).toContain("4 seconds more");
  });

  it("says 'less' when the primary shot came up short", () => {
    const { desc } = describeChart({
      comparison: { ...PRIMARY, id: "411", profileName: "Turbo", weight: 40.2 },
      data: DATA,
      primary: PRIMARY,
    });
    expect(desc).toContain("4 grams less");
  });

  it("calls a negligible difference the same rather than '0 more'", () => {
    const { desc } = describeChart({
      comparison: { ...PRIMARY, id: "411", profileName: "Turbo" },
      data: DATA,
      primary: PRIMARY,
    });
    expect(desc).toContain("the same grams");
    expect(desc).not.toContain("0 grams more");
  });

  it("names hidden series and leaves their peaks out", () => {
    const { desc } = describeChart({
      data: DATA,
      hidden: new Set(["weightFlow", "shotWeight"]),
      primary: PRIMARY,
    });
    expect(desc).toContain("Weight Flow and Weight are currently hidden.");
    expect(desc).not.toContain("weight flow 1.9");
    expect(desc).toContain("pressure 9.1 bar");
  });

  it("uses the singular verb for one hidden series", () => {
    const { desc } = describeChart({
      data: DATA,
      hidden: new Set(["pressure"]),
      primary: PRIMARY,
    });
    expect(desc).toContain("Pressure is currently hidden.");
  });

  // The phase labels are SVG text inside the plot, which a screen reader gets
  // nothing from — so the narration has to carry them itself.
  it("names each profile phase and when it ran", () => {
    const { desc } = describeChart({
      data: DATA,
      phases: [
        { end: 5, index: 0, label: "Flow", start: 0 },
        { end: 32, index: 1, label: "Pressure", start: 5 },
      ],
      primary: PRIMARY,
    });
    expect(desc).toContain(
      "Profile phases: flow from 0 to 5 seconds; pressure from 5 to 32 seconds.",
    );
  });

  it("says nothing about phases when the profile named none", () => {
    const { desc } = describeChart({
      data: DATA,
      phases: [],
      primary: PRIMARY,
    });
    expect(desc).not.toContain("Profile phases");
  });

  it("names only the series actually plotted", () => {
    const { desc } = describeChart({
      data: DATA,
      hidden: new Set(["temperature", "shotWeight"]),
      primary: PRIMARY,
    });
    expect(desc).toContain(
      "Line chart of pressure, flow and weight flow over 32.4 seconds",
    );
    expect(desc).not.toContain("Line chart of pressure, flow, weight flow,");
  });

  it("survives a shot with no datapoints at all", () => {
    const { desc, title } = describeChart({ data: [], primary: PRIMARY });
    expect(title).toContain("Londinium");
    expect(desc).toContain("32.4 seconds");
    expect(desc).not.toContain("Peak values");
  });
});

describe("describePressureFlowPlot", () => {
  const COMPARISON: ShotMeta = {
    duration: 30.1,
    id: "411",
    profileName: "Zer0",
    weight: 34.8,
  };

  it("names both axes so the plot is not mistaken for the time chart", () => {
    const { desc, title } = describePressureFlowPlot({
      data: DATA,
      primary: PRIMARY,
    });
    expect(title).toBe("Espresso pressure against flow: Londinium");
    expect(desc).toContain("group pressure in bar against pump flow");
  });

  // The whole reason this is not a flag on describeChart: every sentence that
  // function produces measures the horizontal axis in seconds, and here it is
  // millilitres per second.
  it("never places a measurement at a time", () => {
    const { desc } = describePressureFlowPlot({ data: DATA, primary: PRIMARY });
    // The one legitimate "seconds" is the shot's own duration in the preamble.
    // Anything of the form "<value> at <n> seconds" is a coordinate read off a
    // horizontal axis that measures millilitres per second.
    expect(desc).not.toMatch(/at [\d.]+ seconds/);
    expect(desc).not.toContain("Line chart");
    // Exactly one plural "seconds" survives: the shot's duration. Every other
    // occurrence is the singular unit "millilitres per second".
    expect(desc.match(/seconds/g)).toHaveLength(1);
  });

  it("traces the path's endpoints and its furthest reach", () => {
    const { desc } = describePressureFlowPlot({ data: DATA, primary: PRIMARY });
    expect(desc).toContain(
      "starts at the marked point, 4.4 millilitres per second at 2.1 bar",
    );
    expect(desc).toContain("ends at 1.8 millilitres per second at 6.4 bar");
    expect(desc).toContain("maximum flow is 4.4 millilitres per second");
  });

  // A peak's horizontal position is the reading a sighted viewer is most likely
  // to misread as a time, so the description says outright that it is not.
  it("says the peak's horizontal position is a flow", () => {
    const { desc } = describePressureFlowPlot({ data: DATA, primary: PRIMARY });
    expect(desc).toContain("Pressure peaks at 9.1 bar");
    expect(desc).toContain("not a time");
  });

  it("names the comparison and how it is drawn", () => {
    const { desc, title } = describePressureFlowPlot({
      comparison: COMPARISON,
      data: DATA,
      primary: PRIMARY,
    });
    expect(title).toContain("compared with Zer0");
    expect(desc).toContain("A second trace overlays Zer0");
    expect(desc).toContain("dashed stroke");
  });

  // Filtering to samples that carry both coordinates can empty the trace, and
  // an empty frame with a confident narration is worse than saying nothing is
  // plotted.
  it("says so when no sample carries both coordinates", () => {
    const { desc } = describePressureFlowPlot({ data: [], primary: PRIMARY });
    expect(desc).toContain("No sample carries both");
    expect(desc).not.toContain("Pressure peaks");
    expect(desc).not.toContain("The trace runs");
  });
});

/**
 * A sample carrying only one of the two readings has no position on this plot,
 * so it is not narrated as if it had one. The `?? 0` guard that would otherwise
 * sit on these reads is the specific hazard: it reports an absent measurement as
 * a measured zero.
 */
describe("describePressureFlowPlot with incomplete samples", () => {
  const HOLED: ChartDataPoint[] = [
    { pressure: 2, pumpFlow: 4, shotWeight: 0, time: 0, weightFlow: 0 },
    { pressure: 9, shotWeight: 4, time: 1, weightFlow: 1 },
    { pressure: 7, pumpFlow: 1.5, shotWeight: 20, time: 2, weightFlow: 1 },
  ];

  it("reads its endpoints from the samples actually plotted", () => {
    const { desc } = describePressureFlowPlot({
      data: HOLED,
      primary: PRIMARY,
    });
    expect(desc).toContain("4 millilitres per second at 2 bar");
    expect(desc).toContain("ends at 1.5 millilitres per second at 7 bar");
    // Never "0 millilitres per second" from a missing reading.
    expect(desc).not.toContain("0 millilitres per second at");
  });

  it("takes the peak from a placeable sample, not the highest pressure", () => {
    // 9 bar is the highest reading in the series and has no flow, so it is not
    // on the plot at all — narrating it would point at a position that is empty.
    const { desc } = describePressureFlowPlot({
      data: HOLED,
      primary: PRIMARY,
    });
    expect(desc).toContain("Pressure peaks at 7 bar");
    expect(desc).not.toContain("Pressure peaks at 9 bar");
  });

  it("says how many samples could not be placed", () => {
    const { desc } = describePressureFlowPlot({
      data: HOLED,
      primary: PRIMARY,
    });
    expect(desc).toContain("1 sample recorded only one of the two readings");
    expect(desc).toContain("drawn with a break");
  });

  it("stays silent about breaks when every sample is placeable", () => {
    const { desc } = describePressureFlowPlot({ data: DATA, primary: PRIMARY });
    expect(desc).not.toContain("cannot be placed");
  });
});
