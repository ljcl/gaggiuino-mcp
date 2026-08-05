import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { mockMachineStatus } from "./__fixtures__/api-responses";
import { getClient, getUpstreamHealth, resetClient } from "./client";
import { buildHealth } from "./health";
import { mockServer } from "./test-setup";
import { SERVER_VERSION } from "./version";

beforeEach(() => {
  resetClient({ initialDelayMs: 1, maxRetries: 1 });
});

describe("buildHealth", () => {
  it("reports the released version and a whole-second uptime", () => {
    const payload = buildHealth({ uptimeSec: () => 12.7 });
    expect(payload.status).toBe("ok");
    expect(payload.version).toBe(SERVER_VERSION);
    expect(payload.uptimeSec).toBe(13);
  });

  it("names the configured machine so a bad GAGGIUINO_URL is visible", () => {
    const payload = buildHealth({ machineUrl: "http://192.168.1.50" });
    expect(payload.machine.url).toBe("http://192.168.1.50");
  });

  it("reports unknown before anything has talked to the machine", () => {
    // Honest rather than optimistic: nothing has been observed yet, and
    // /health deliberately does not generate traffic to find out.
    expect(buildHealth().machine.state).toBe("unknown");
  });

  describe("firmware versions", () => {
    it("reports null before anything has read the settings", () => {
      // Same honesty as `state`: this server has not looked, and saying so is
      // different from claiming the machine reports no version.
      expect(buildHealth().machine.versions).toBeNull();
    });

    it("remembers the versions a settings read went past", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.json([
            {
              boiler: { steamSetPoint: 145 },
              versions: {
                coreVersion: "a06f97fd",
                frontVersion: "a06f97fd",
                staticVersion: "a06f97fd",
              },
            },
          ]),
        ),
      );
      await getClient().getSettings();

      expect(buildHealth().machine.versions).toMatchObject({
        coreVersion: "a06f97fd",
      });
    });

    it("does not fail a settings read whose versions block is malformed", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.json([{ boiler: {}, versions: "not an object" }]),
        ),
      );

      await expect(getClient().getSettings()).resolves.toMatchObject({
        boiler: {},
      });
      expect(buildHealth().machine.versions).toBeNull();
    });

    it("publishes only the three documented fields", async () => {
      // /health is served unauthenticated for the container's benefit, so a
      // key a future firmware adds under `versions` must not become public
      // here without anyone deciding it should be.
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.json([
            {
              versions: {
                coreVersion: "a06f97fd",
                provisioningKey: "should-not-be-published",
              },
            },
          ]),
        ),
      );
      await getClient().getSettings();

      expect(buildHealth().machine.versions).toEqual({
        coreVersion: "a06f97fd",
        frontVersion: null,
        staticVersion: null,
      });
    });

    it("reports a versions block that carries none of them as all-null", () => {
      // Distinct from `versions: null`, which means this server has not looked.
      expect(buildHealth({ versions: () => ({}) }).machine.versions).toEqual({
        coreVersion: null,
        frontVersion: null,
        staticVersion: null,
      });
    });

    it("makes no request of its own", () => {
      // The assertion that keeps /health off the upstream forever. The
      // container HEALTHCHECK runs this every 30s against an ESP32 that serves
      // one request at a time, and `buildHealth` is synchronous so it cannot.
      expect(buildHealth).not.toBeInstanceOf(
        Object.getPrototypeOf(async () => {}).constructor,
      );
      expect(buildHealth().machine.versions).toBeNull();
    });
  });
});

describe("observed upstream state", () => {
  it("turns ok once the machine answers", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.json([mockMachineStatus]),
      ),
    );
    await getClient().getStatus();

    const payload = buildHealth();
    expect(payload.machine.state).toBe("ok");
    expect(payload.machine.lastCheckedAt).toBeTruthy();
  });

  it("stays ok when the machine answers with an error status", async () => {
    // A 404 for a shot that does not exist still proves the network path
    // works, so it must not read as "machine unreachable".
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/999", () =>
        HttpResponse.json({ message: "not found" }, { status: 404 }),
      ),
    );
    await expect(getClient().getShotData("999")).rejects.toThrow();
    expect(buildHealth().machine.state).toBe("ok");
  });

  it("turns unreachable, with the reason, on a network failure", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.error(),
      ),
    );
    await expect(getClient().getStatus()).rejects.toThrow();

    const payload = buildHealth();
    expect(payload.machine.state).toBe("unreachable");
    expect(payload.machine.lastError).toBeTruthy();
  });

  it("resets to unknown with the client, so tests do not leak state", () => {
    resetClient();
    expect(getUpstreamHealth().state).toBe("unknown");
  });
});
