import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_MACHINE_URL,
  DEFAULT_PORT,
  loadServerConfig,
} from "./config";

describe("defaults", () => {
  it("falls back to the documented defaults on an empty environment", () => {
    expect(loadServerConfig({})).toEqual({
      host: DEFAULT_HOST,
      machineUrl: DEFAULT_MACHINE_URL,
      port: DEFAULT_PORT,
    });
  });

  it("treats a blank value as unset rather than as an empty setting", () => {
    // `PORT=` in a .env file is the shape this guards against.
    expect(
      loadServerConfig({ GAGGIUINO_URL: "  ", HOST: "", PORT: "" }),
    ).toEqual({
      host: DEFAULT_HOST,
      machineUrl: DEFAULT_MACHINE_URL,
      port: DEFAULT_PORT,
    });
  });
});

describe("PORT", () => {
  it("accepts a valid port", () => {
    expect(loadServerConfig({ PORT: "9001" }).port).toBe(9001);
  });

  it.each([
    ["eight-thousand", "non-numeric"],
    ["0", "below the range"],
    ["65536", "above the range"],
    ["-1", "negative"],
    ["8000.5", "fractional"],
  ])("rejects %s (%s)", (value) => {
    // The bare `Number(...)` this replaced turned every one of these into a
    // bind on NaN and an error that never mentioned PORT.
    expect(() => loadServerConfig({ PORT: value })).toThrow(ConfigError);
    expect(() => loadServerConfig({ PORT: value })).toThrow(/PORT/);
  });
});

describe("GAGGIUINO_URL", () => {
  it("accepts http and https", () => {
    expect(
      loadServerConfig({ GAGGIUINO_URL: "http://192.168.1.50" }).machineUrl,
    ).toBe("http://192.168.1.50");
    expect(
      loadServerConfig({ GAGGIUINO_URL: "https://gaggiuino.example" })
        .machineUrl,
    ).toBe("https://gaggiuino.example");
  });

  it("strips a trailing slash, which the client would otherwise double up", () => {
    expect(
      loadServerConfig({ GAGGIUINO_URL: "http://a.test/" }).machineUrl,
    ).toBe("http://a.test");
  });

  it("rejects a bare hostname and says what is missing", () => {
    // The likeliest typo, and previously it surfaced much later as a failed
    // fetch blamed on the machine being offline.
    expect(() =>
      loadServerConfig({ GAGGIUINO_URL: "gaggiuino.local" }),
    ).toThrow(/http:\/\/ prefix/);
  });

  it("rejects a non-http scheme", () => {
    expect(() => loadServerConfig({ GAGGIUINO_URL: "ftp://a.test" })).toThrow(
      /http or https/,
    );
  });
});
