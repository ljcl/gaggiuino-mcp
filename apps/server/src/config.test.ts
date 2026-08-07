import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_MACHINE_URL,
  DEFAULT_PORT,
  loadServerConfig,
  parsePublicUrl,
} from "./config";

describe("parsePublicUrl", () => {
  it("treats absent and blank as unset", () => {
    expect(parsePublicUrl(undefined)).toBeUndefined();
    expect(parsePublicUrl("   ")).toBeUndefined();
  });

  it("returns the origin unchanged when it is already canonical", () => {
    expect(parsePublicUrl("https://box.tail1234.ts.net")).toBe(
      "https://box.tail1234.ts.net",
    );
  });

  it("canonicalises rather than rejecting the forms URL can normalise", () => {
    // The advertised `resource` has to be the RFC 8707 canonical form, which is
    // what a client sends back. `URL` already lowercases the scheme and host,
    // drops a default `:443` and drops a trailing slash, so these are the same
    // deployment described four ways — rejecting them would be pedantry that
    // costs an operator an afternoon.
    for (const written of [
      "https://BOX.Tail1234.TS.NET",
      "https://box.tail1234.ts.net/",
      "https://box.tail1234.ts.net:443",
      "  https://box.tail1234.ts.net  ",
    ]) {
      expect(parsePublicUrl(written), written).toBe(
        "https://box.tail1234.ts.net",
      );
    }
  });

  it("keeps a non-default port", () => {
    expect(parsePublicUrl("https://example.test:8443")).toBe(
      "https://example.test:8443",
    );
  });

  it("rejects a URL it cannot parse, naming the likely mistake", () => {
    expect(() => parsePublicUrl("box.tail1234.ts.net")).toThrow(ConfigError);
    expect(() => parsePublicUrl("box.tail1234.ts.net")).toThrow(/https:\/\//);
  });

  it("rejects plain http", () => {
    // Claude reaches this over the public internet; OAuth credentials cannot
    // cross plain HTTP.
    expect(() => parsePublicUrl("http://box.tail1234.ts.net")).toThrow(
      ConfigError,
    );
  });

  it("rejects credentials, which discovery metadata would publish", () => {
    expect(() => parsePublicUrl("https://user:pw@example.test")).toThrow(
      ConfigError,
    );
  });

  it("rejects a path, query or fragment and suggests the origin", () => {
    // A path would break the assumption the built-in authorization server rests
    // on: an issuer that is a bare origin is what collapses RFC 8414's
    // path-insertion rule to one well-known path.
    for (const written of [
      "https://example.test/mcp",
      "https://example.test/?x=1",
      "https://example.test/#frag",
    ]) {
      expect(() => parsePublicUrl(written), written).toThrow(ConfigError);
    }
    expect(() => parsePublicUrl("https://example.test/mcp")).toThrow(
      /https:\/\/example\.test/,
    );
  });
});

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

describe("MCP_AUTH_TOKEN tombstone", () => {
  it("refuses to start while the removed variable is set", () => {
    // The failure this exists to prevent is silent: with the variable simply
    // unread, a deployment that gated /mcp with it would come up open and log
    // nothing to say the gate had gone.
    expect(() => loadServerConfig({ MCP_AUTH_TOKEN: "old-secret" })).toThrow(
      ConfigError,
    );
    expect(() => loadServerConfig({ MCP_AUTH_TOKEN: "old-secret" })).toThrow(
      /MCP_AUTH_TOKEN/,
    );
  });

  it("names the OAuth variables to configure instead", () => {
    // Refusing to boot without saying what to do next just moves the outage.
    try {
      loadServerConfig({ MCP_AUTH_TOKEN: "old-secret" });
      expect.unreachable("expected a ConfigError");
    } catch (error) {
      const message = (error as Error).message;
      for (const name of [
        "MCP_PUBLIC_URL",
        "MCP_OAUTH_SECRET",
        "MCP_OAUTH_PASSPHRASE_HASH",
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it("treats blank and whitespace as unset", () => {
    // `MCP_AUTH_TOKEN=` left behind in a compose file is a stale line, not a
    // configured secret, and refusing to start over it would be a worse
    // outcome than the one this guard exists to prevent.
    expect(loadServerConfig({ MCP_AUTH_TOKEN: "" }).port).toBe(DEFAULT_PORT);
    expect(loadServerConfig({ MCP_AUTH_TOKEN: "   " }).port).toBe(DEFAULT_PORT);
  });

  it("refuses before it reports anything else that is wrong", () => {
    // Two problems, one answer: stop. Reporting the PORT first would send the
    // operator to fix the variable that is not the reason for the exit.
    expect(() =>
      loadServerConfig({ MCP_AUTH_TOKEN: "old-secret", PORT: "not-a-port" }),
    ).toThrow(/MCP_AUTH_TOKEN/);
  });
});
