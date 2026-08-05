import { describe, expect, it } from "vitest";
import {
  extractServiceHistory,
  formatMaintenance,
  type MaintenanceReading,
} from "./maintenance";

/** `docs/upstream/rest-api.md` L472-479, verbatim. */
const documented = {
  lastDescaleTimestamp: 1753900000,
  shotsSinceDescale: 42,
  lastBackflushTimestamp: 1753000000,
  shotsSinceBackflush: 10,
};

/** 2026-08-04T12:00:00Z — after both documented timestamps. */
const NOW_MS = 1785931200000;

function readingOf(raw: Record<string, unknown>): MaintenanceReading {
  return extractServiceHistory(raw);
}

describe("extractServiceHistory", () => {
  it("pairs each timestamp with its own counter", () => {
    const { extras, services } = readingOf(documented);

    expect(extras).toEqual({});
    expect(services).toEqual([
      {
        lastAt: "2025-07-30T18:26:40.000Z",
        lastEpochSec: 1753900000,
        service: "descale",
        shotsSince: 42,
      },
      {
        lastAt: "2025-07-20T08:26:40.000Z",
        lastEpochSec: 1753000000,
        service: "backflush",
        shotsSince: 10,
      },
    ]);
  });

  it("reads a service this server has never heard of", () => {
    // The reason the list is derived rather than enumerated: a firmware that
    // starts logging filter changes is carried with no schema change.
    const { services } = readingOf({
      lastWaterFilterTimestamp: 1753900000,
      shotsSinceWaterFilter: 7,
    });

    expect(services).toEqual([
      {
        lastAt: "2025-07-30T18:26:40.000Z",
        lastEpochSec: 1753900000,
        service: "waterFilter",
        shotsSince: 7,
      },
    ]);
  });

  it("treats 0 as never recorded rather than as 1970", () => {
    const { services } = readingOf({
      lastDescaleTimestamp: 0,
      shotsSinceDescale: 130,
    });

    expect(services[0]?.lastEpochSec).toBeNull();
    expect(services[0]?.lastAt).toBeNull();
    expect(services[0]?.shotsSince).toBe(130);
  });

  it("refuses to date a timestamp from a clock that was never set", () => {
    const { services } = readingOf({ lastDescaleTimestamp: 4200 });

    // Not null-because-never: the machine did record something, so the epoch is
    // kept and only the ISO rendering is withheld.
    expect(services[0]?.lastEpochSec).toBe(4200);
    expect(services[0]?.lastAt).toBeNull();
  });

  it("absorbs a counter sent as a decimal string", () => {
    const { services } = readingOf({
      lastDescaleTimestamp: "1753900000",
      shotsSinceDescale: "42",
    });

    expect(services[0]?.lastEpochSec).toBe(1753900000);
    expect(services[0]?.shotsSince).toBe(42);
  });

  it("reports a counter with no timestamp as an extra rather than inventing a service", () => {
    const { extras, services } = readingOf({ shotsSinceGasket: 3 });

    expect(services).toEqual([]);
    expect(extras).toEqual({ shotsSinceGasket: 3 });
  });

  it("keeps an unreadable timestamp out of the services list", () => {
    // Otherwise `lastEpochSec: null` would mean two different things, and
    // "never descaled" would be indistinguishable from "the machine said
    // something we could not read".
    const { extras, services } = readingOf({
      lastDescaleTimestamp: "not a date",
      shotsSinceDescale: 42,
    });

    expect(services).toEqual([]);
    expect(extras).toEqual({
      lastDescaleTimestamp: "not a date",
      shotsSinceDescale: 42,
    });
  });

  it("leaves shotsSince null when the firmware sends no counter", () => {
    const { services } = readingOf({ lastDescaleTimestamp: 1753900000 });
    expect(services[0]?.shotsSince).toBeNull();
  });

  it("survives an epoch too large for a Date rather than throwing", () => {
    // `new Date(ms).toISOString()` throws past ±8.64e15 ms. An expected
    // upstream oddity must not surface as an uncaught RangeError.
    const { services } = readingOf({ lastDescaleTimestamp: 9007199254740991 });

    expect(services[0]?.lastAt).toBeNull();
    expect(services[0]?.lastEpochSec).toBe(9007199254740991);
  });

  it("surfaces a counter it could not read rather than hiding it", () => {
    // Consuming the key either way would make "not reported by this firmware"
    // a lie about a counter the firmware did report.
    const { extras, services } = readingOf({
      lastDescaleTimestamp: 1753900000,
      shotsSinceDescale: "n/a",
    });

    expect(services[0]?.shotsSince).toBeNull();
    expect(extras).toEqual({ shotsSinceDescale: "n/a" });
  });
});

describe("formatMaintenance", () => {
  it("renders both services with how long ago they were", () => {
    const text = formatMaintenance(readingOf(documented), NOW_MS);

    expect(text).toContain("## Descale");
    expect(text).toContain("## Backflush");
    expect(text).toContain("2025-07-30T18:26:40.000Z");
    expect(text).toContain("Shots since: 42");
    expect(text).toContain("about 12 months ago");
  });

  it("never prints a 1970 date for a machine that has never been descaled", () => {
    const text = formatMaintenance(
      readingOf({ lastDescaleTimestamp: 0, shotsSinceDescale: 130 }),
      NOW_MS,
    );

    expect(text).not.toContain("1970");
    expect(text).toContain("never — this machine has not recorded one");
  });

  it("says the machine's clock was unset rather than dating from 1970", () => {
    const text = formatMaintenance(
      readingOf({ lastDescaleTimestamp: 4200 }),
      NOW_MS,
    );

    expect(text).not.toContain("1970");
    expect(text).toContain("clock was probably not set");
  });

  it.each([
    [NOW_MS / 1000, "today"],
    [NOW_MS / 1000 - 86_400, "1 day ago"],
    [NOW_MS / 1000 - 9 * 86_400, "9 days ago"],
    [NOW_MS / 1000 - 240 * 86_400, "about 8 months ago"],
    [NOW_MS / 1000 + 86_400, "clock may not be set"],
  ])("describes epoch %i as %s", (epochSec, expected) => {
    const text = formatMaintenance(
      readingOf({ lastDescaleTimestamp: epochSec }),
      NOW_MS,
    );
    expect(text).toContain(expected);
  });

  it("states how the machine counts, so the numbers are not read as a full service record", () => {
    const text = formatMaintenance(readingOf(documented), NOW_MS);

    expect(text).toContain("50%");
    expect(text).toContain("10 bar");
    expect(text).toContain("5 seconds");
    expect(text).toContain("UTC");
  });

  it("says the log is empty rather than rendering nothing", () => {
    const text = formatMaintenance(readingOf({}), NOW_MS);
    expect(text).toContain("service log is empty");
  });

  it("prints fields it could not pair rather than dropping them", () => {
    const text = formatMaintenance(
      readingOf({ nested: { a: 1 }, someFutureField: "yes" }),
      NOW_MS,
    );

    expect(text).toContain("someFutureField: yes");
    expect(text).toContain('nested: {"a":1}');
  });

  it("says when a firmware reports no counter for a service", () => {
    const text = formatMaintenance(
      readingOf({ lastDescaleTimestamp: 1753900000 }),
      NOW_MS,
    );
    expect(text).toContain("Shots since: not reported by this firmware");
  });
});
