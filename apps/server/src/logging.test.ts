import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  type LogLevel,
  logger,
  parseLogLevel,
  setLogLevel,
} from "./logging";

/** A logger with an injected sink and clock, so records assert exactly. */
function capture(level?: LogLevel) {
  const lines: string[] = [];
  return {
    // Deliberately not named `logger`: that name is the process-wide singleton
    // imported above, which the last describe block exercises directly.
    isolated: createLogger({
      level,
      now: () => new Date("2026-07-27T09:00:00.000Z"),
      write: (line) => lines.push(line),
    }),
    records: () => lines.map((line) => JSON.parse(line)),
  };
}

describe("parseLogLevel", () => {
  it("accepts the known levels case-insensitively", () => {
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(" debug ")).toBe("debug");
  });

  it("falls back to info for anything unrecognised", () => {
    // A typo in LOG_LEVEL must not silence the server.
    expect(parseLogLevel("verbose")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("")).toBe("info");
  });
});

describe("records", () => {
  it("writes one JSON object per line with level, event and time", () => {
    const { isolated, records } = capture();
    isolated.info("tool.call", {
      durationMs: 12,
      outcome: "ok",
      tool: "get_status",
    });
    expect(records()).toEqual([
      {
        durationMs: 12,
        event: "tool.call",
        level: "info",
        outcome: "ok",
        time: "2026-07-27T09:00:00.000Z",
        tool: "get_status",
      },
    ]);
  });

  it("emits a usable record with no fields at all", () => {
    const { isolated, records } = capture();
    isolated.warn("security.unauthenticated");
    expect(records()[0]).toMatchObject({
      event: "security.unauthenticated",
      level: "warn",
    });
  });
});

describe("levels", () => {
  it("drops records below the configured level", () => {
    const { isolated, records } = capture("warn");
    isolated.debug("a");
    isolated.info("b");
    isolated.warn("c");
    isolated.error("d");
    expect(records().map((record) => record.event)).toEqual(["c", "d"]);
  });

  it("drops everything at silent, which is what the test suite runs at", () => {
    const { isolated, records } = capture("silent");
    isolated.error("boom");
    expect(records()).toEqual([]);
  });

  it("passes everything at debug", () => {
    const { isolated, records } = capture("debug");
    isolated.debug("a");
    isolated.error("b");
    expect(records()).toHaveLength(2);
  });
});

describe("the process-wide logger", () => {
  /**
   * This is the object every module imports, so its delegation and its lazy
   * reconfiguration are worth asserting directly. `test-setup.ts` sets the
   * level to silent for the whole suite; each test here sets what it needs and
   * the afterEach puts it back.
   */
  afterEach(() => {
    setLogLevel("silent");
    vi.restoreAllMocks();
  });

  function captureStderr() {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    return () => lines.map((line) => JSON.parse(line));
  }

  it("routes every level through to the default stderr sink", () => {
    const records = captureStderr();
    setLogLevel("debug");
    logger.debug("a.debug");
    logger.info("b.info");
    logger.warn("c.warn");
    logger.error("d.error");
    expect(records().map((record) => [record.level, record.event])).toEqual([
      ["debug", "a.debug"],
      ["info", "b.info"],
      ["warn", "c.warn"],
      ["error", "d.error"],
    ]);
  });

  it("applies a level change to the next call, not just to a fresh logger", () => {
    // The level resolves lazily on first use precisely so a setup file can
    // change it regardless of module import order; a cached logger built at
    // import time would ignore this.
    const records = captureStderr();
    setLogLevel("error");
    logger.info("dropped");
    expect(records()).toEqual([]);

    setLogLevel("info");
    logger.info("kept");
    expect(records().map((record) => record.event)).toEqual(["kept"]);
  });
});
