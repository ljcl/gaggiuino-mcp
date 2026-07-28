import { describe, expect, it } from "vitest";
import { describeChart } from "./a11y";
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

  it("survives a shot with no datapoints at all", () => {
    const { desc, title } = describeChart({ data: [], primary: PRIMARY });
    expect(title).toContain("Londinium");
    expect(desc).toContain("32.4 seconds");
    expect(desc).not.toContain("Peak values");
  });
});
