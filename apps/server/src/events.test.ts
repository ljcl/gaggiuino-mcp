import {
  londiniumShot32,
  londiniumShot33,
} from "@gaggiuino/shot-graph/fixtures";
import { describe, expect, it } from "vitest";
import { detectPressureCollapses } from "./events";

/** Raw x10 wire units, the format the machine actually sends. */
function series(
  pressureBar: number[],
  targetBar: number[],
  startSec = 10,
  intervalSec = 0.15,
) {
  return {
    timeInShot: pressureBar.map((_, i) =>
      Math.round((startSec + i * intervalSec) * 10),
    ),
    pressure: pressureBar.map((v) => Math.round(v * 10)),
    targetPressure: targetBar.map((v) => Math.round(v * 10)),
  };
}

function flat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

/** Raw x10 units, with the sample times stated rather than derived. */
function atTimes(
  timesSec: number[],
  pressureBar: number[],
  targetBar: number[],
) {
  return {
    timeInShot: timesSec.map((v) => Math.round(v * 10)),
    pressure: pressureBar.map((v) => Math.round(v * 10)),
    targetPressure: targetBar.map((v) => Math.round(v * 10)),
  };
}

describe("detectPressureCollapses", () => {
  it("finds nothing in a real shot on a tapering profile", () => {
    // londiniumShot33 lowers its own target from 8.8 bar to 6.3 across the
    // shot. A detector that compared pressure against a fixed band, or that
    // ignored the target, would report this shot as failing continuously.
    expect(detectPressureCollapses(londiniumShot33.datapoints)).toEqual([]);
    expect(detectPressureCollapses(londiniumShot32.datapoints)).toEqual([]);
  });

  it("finds a sustained fall the profile did not command", () => {
    // 9.0 bar held, then 3 bar lost over ~0.9s: 3.3 bar/s.
    const pressure = [
      ...flat(9, 8),
      8.4,
      7.6,
      6.8,
      6.2,
      6,
      6,
      6,
      6,
      6,
      6,
      6,
      6,
    ];
    const collapses = detectPressureCollapses(
      series(pressure, flat(9, pressure.length)),
    );

    expect(collapses).toHaveLength(1);
    expect(collapses[0]?.dropBar).toBeGreaterThan(2.5);
    expect(collapses[0]?.targetBar).toBe(9);
  });

  it("reports one event for one collapse, not one per window", () => {
    // A long fall trips many overlapping windows; they must merge.
    const pressure = [
      ...flat(9, 6),
      8.5,
      8,
      7.5,
      7,
      6.5,
      6,
      5.5,
      5,
      4.5,
      4,
      ...flat(4, 8),
    ];
    expect(
      detectPressureCollapses(series(pressure, flat(9, pressure.length))),
    ).toHaveLength(1);
  });

  it("ignores a commanded step down, however steep", () => {
    // Zer0 steps its target 6 bar -> 2.5 mid-shot and pressure follows.
    const pressure = [
      ...flat(6.3, 6),
      5.6,
      4.9,
      4.1,
      3.5,
      3.1,
      2.8,
      ...flat(2.5, 10),
    ];
    const target = [...flat(6, 6), ...flat(2.5, pressure.length - 6)];

    expect(detectPressureCollapses(series(pressure, target))).toEqual([]);
  });

  it("ignores a fall while the profile is driving flow, not pressure", () => {
    // targetPressure is 0 during a flow phase — "not commanding pressure",
    // not "a steady target of zero". A real fill-to-extraction handover falls
    // faster than the threshold.
    const pressure = [...flat(4, 6), 3.2, 2.4, 1.6, 1, 0.6, ...flat(0.5, 8)];

    expect(
      detectPressureCollapses(series(pressure, flat(0, pressure.length))),
    ).toEqual([]);
  });

  it("ignores the pressure release as the shot ends", () => {
    // The pump stops when the stop condition is met and pressure dumps on the
    // final sample at ~5.8 bar/s, twice the threshold.
    //
    // The times are stated rather than derived because the spacing is the whole
    // point: the final sample has to be the *first* one a half-second window
    // can reach, which is exactly when the end-of-shot exclusion is load
    // bearing. At an even 0.15s cadence some earlier sample always qualifies
    // first and the exclusion never gets asked.
    expect(
      detectPressureCollapses(
        atTimes([10, 10.2, 10.4, 10.6], [9, 9, 9, 3], flat(9, 4)),
      ),
    ).toEqual([]);
  });

  it("ignores a commanded step even when pressure overshoots below the new target", () => {
    // The target steps 9 bar -> 6 and the pressure undershoots to 5.5 on its
    // way to settling. Ending below the commanded target is normally the signal
    // that something failed; here the target moved, so it is not.
    expect(
      detectPressureCollapses(
        atTimes(
          [10, 10.2, 10.4, 10.6, 10.8, 11],
          [9, 9, 8, 6.5, 5.5, 5.5],
          [9, 6, 6, 6, 6, 6],
        ),
      ),
    ).toEqual([]);
  });

  it("does not trip on single-sample sensor noise", () => {
    // Adjacent-sample noise alone can exceed the rate threshold; the
    // half-second minimum window is what makes that survivable.
    const pressure = [
      9, 8.6, 9.2, 8.8, 9.2, 8.8, 9.1, 8.7, 9.2, 8.9, 9, 8.7, 9.1,
    ];

    expect(
      detectPressureCollapses(series(pressure, flat(9, pressure.length))),
    ).toEqual([]);
  });

  it("returns nothing when a series is too short or absent", () => {
    expect(detectPressureCollapses({})).toEqual([]);
    expect(
      detectPressureCollapses({
        timeInShot: [0, 1],
        pressure: [90, 20],
        targetPressure: [90, 90],
      }),
    ).toEqual([]);
  });

  it("treats a reading with no matching sample as absent, not as zero pressure", () => {
    // timeInShot is the spine. A pressure series that stops early would look
    // like a fall to 0 bar if the missing samples were read as real readings;
    // they are not, because the target gate rejects them first.
    const pressure = [...flat(9, 8), 8.4, 7.6, 6.8, 6.2, ...flat(6, 6)];
    const full = series(pressure, flat(9, pressure.length));

    expect(
      detectPressureCollapses({ ...full, pressure: [90, 90, 90] }),
    ).toEqual([]);
  });

  it("uses only the length the shortest series supports", () => {
    // The boundary schema requires no two series to agree on length.
    const pressure = [...flat(9, 8), 8.4, 7.6, 6.8, 6.2, ...flat(6, 6)];
    const full = series(pressure, flat(9, pressure.length));

    expect(
      detectPressureCollapses({ ...full, targetPressure: [90, 90, 90] }),
    ).toEqual([]);
  });
});
