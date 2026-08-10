import { describe, expect, it } from "vitest";
import { requireSeries, SERIES } from "./constants";

/**
 * `requireSeries` is the total lookup a view uses when it knows at author time
 * which strokes it draws. The throw is the point: the tidy alternative —
 * `SERIES_BY_KEY.get(key) ?? PRIMARY_SERIES[0]` — resolves a different metric's
 * colour and dash, so a key that stopped existing would ship as a chart in the
 * wrong colour instead of as a failure.
 */
describe("requireSeries", () => {
  // Identity, not equality: a caller styles a stroke from this and the Chart
  // accessibility story measures `SERIES`. A structurally-equal copy would pass
  // a deep comparison and could still drift from the measured entry.
  it("returns the registry's own entry, not a copy of it", () => {
    for (const series of SERIES) {
      expect(SERIES).toContain(requireSeries(series.dataKey as string));
    }
  });

  it("throws for a key no series is registered under", () => {
    expect(() => requireSeries("pressureCmpCmp")).toThrow(
      /No chart series is registered/,
    );
  });

  // The two the pressure-against-flow plot draws. Named here rather than only
  // in that component, so renaming a metric fails in a test that says why.
  it("resolves the strokes the phase plot draws", () => {
    expect(requireSeries("pressure").isComparison).toBe(false);
    expect(requireSeries("pressureCmp").isComparison).toBe(true);
    expect(requireSeries("pressureCmp").color).toBe(
      requireSeries("pressure").color,
    );
  });
});
