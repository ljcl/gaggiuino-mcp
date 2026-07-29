import { describe, expect, it } from "vitest";
import { shotCsv, shotCsvFilename } from "./csv";
import { type ChartDataPoint, type ShotMeta } from "./types";

const meta = (id: string): ShotMeta => ({
  duration: 30,
  id,
  profileName: "Londinium",
  weight: 36,
});

const points: ChartDataPoint[] = [
  { pressure: 2.1, pressureCmp: 1.9, shotWeight: 0, time: 0 },
  { pressure: 9.1, pressureCmp: 8.7, shotWeight: 1.4, time: 0.1 },
];

describe("shotCsv", () => {
  it("labels columns with their units", () => {
    const header = shotCsv(points, false).split("\n")[0];
    expect(header).toBe(
      "time_s,pressure_bar,target_pressure_bar,pump_flow_ml_s,target_pump_flow_ml_s,weight_flow_g_s,weight_g,temperature_c",
    );
  });

  it("writes the normalized values, blanking absent series", () => {
    expect(shotCsv(points, false).split("\n")[1]).toBe("0,2.1,,,,,0,");
  });

  it("omits comparison columns when there is no comparison", () => {
    expect(shotCsv(points, false)).not.toContain("cmp_");
  });

  it("appends comparison columns when overlaying a second shot", () => {
    const lines = shotCsv(points, true).split("\n");
    expect(lines[0]).toContain("cmp_pressure_bar");
    expect(lines[1]).toBe("0,2.1,,,,,0,,1.9,,,,,,");
  });

  it("exports a row per datapoint plus the header", () => {
    expect(shotCsv(points, false).split("\n")).toHaveLength(3);
  });
});

describe("shotCsvFilename", () => {
  it("names a single shot", () => {
    expect(shotCsvFilename(meta("33"))).toBe("shot-33.csv");
  });

  it("names both shots when comparing", () => {
    expect(shotCsvFilename(meta("33"), meta("32"))).toBe("shot-33-vs-32.csv");
  });
});
