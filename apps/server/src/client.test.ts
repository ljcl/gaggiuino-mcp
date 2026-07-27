import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  mockMachineStatus,
  mockMachineStatusFromHardware,
  mockShotData,
} from "./__fixtures__/api-responses";
import { createClient } from "./client";
import {
  MalformedUpstreamError,
  UpstreamHttpError,
  UpstreamUnreachableError,
} from "./errors";
import { mockServer } from "./test-setup";

describe("client", () => {
  describe("getStatus", () => {
    it("fetches and returns machine status", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json([mockMachineStatus]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const status = await client.getStatus();

      expect(status.temperature).toBe(91);
      expect(status.profileName).toBe("Zer0");
    });

    it("coerces the stringly-typed numerics real firmware sends", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json([mockMachineStatusFromHardware]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const status = await client.getStatus();

      expect(status.temperature).toBe(77.627335);
      expect(status.targetTemperature).toBe(95);
      expect(status.pressure).toBe(6.422525);
      expect(status.weight).toBe(-0.1);
      expect(status.waterLevel).toBe(79);
      expect(status.upTime).toBe(56);
      expect(status.profileName).toBe("Zer0");
    });

    it("still rejects a non-numeric string rather than yielding NaN", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json([
            { ...mockMachineStatusFromHardware, temperature: "warming up" },
          ]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.getStatus()).rejects.toThrow(MalformedUpstreamError);
    });
  });

  describe("getLatestShotId", () => {
    it("fetches and returns the latest shot ID", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{ lastShotId: "1706547890" }]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const shotId = await client.getLatestShotId();

      expect(shotId).toBe("1706547890");
    });

    it("returns empty string when no shot available", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{}]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const shotId = await client.getLatestShotId();

      expect(shotId).toBe("");
    });
  });

  describe("getShotData", () => {
    it("fetches shot data by ID", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.json([mockShotData]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const shot = await client.getShotData("1706547890");

      expect(shot.id).toBe("1706547890");
      expect(shot.profile.name).toBe("LMD 9-8 v1.5 (milk)");
    });
  });

  describe("non-array response handling", () => {
    it("handles API returning object instead of array", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json(mockMachineStatus),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const status = await client.getStatus();

      expect(status.temperature).toBe(91);
    });
  });

  describe("retry logic", () => {
    it("retries on network failure", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          if (attempts < 2) {
            return HttpResponse.error();
          }
          return HttpResponse.json([mockMachineStatus]);
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 10,
      });
      const status = await client.getStatus();

      expect(attempts).toBe(2);
      expect(status.temperature).toBe(91);
    });

    it("does not retry on HTTP 404", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          return HttpResponse.json({ error: "Not found" }, { status: 404 });
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 10,
      });

      await expect(client.getStatus()).rejects.toThrow(UpstreamHttpError);
      expect(attempts).toBe(1);
    });

    it("gives up with an unreachable error after exhausting retries", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          return HttpResponse.error();
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
        maxRetries: 2,
      });

      await expect(client.getStatus()).rejects.toThrow(
        UpstreamUnreachableError,
      );
      expect(attempts).toBe(2);
    });

    it("aborts a request that outlives the timeout and retries", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", async () => {
          attempts += 1;
          if (attempts === 1) {
            await delay(200);
          }
          return HttpResponse.json([mockMachineStatus]);
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
        timeoutMs: 20,
      });

      const status = await client.getStatus();
      expect(attempts).toBe(2);
      expect(status.temperature).toBe(91);
    });
  });

  describe("upstream payload validation", () => {
    it("rejects an empty array as a malformed response", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1", () =>
          HttpResponse.json([]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.getShotData("1")).rejects.toThrow(
        MalformedUpstreamError,
      );
    });

    it("names the missing fields in the malformed error", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1", () =>
          HttpResponse.json([{ id: "1", duration: 340 }]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.getShotData("1")).rejects.toThrow(/datapoints/);
    });

    it("does not retry a malformed response", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          return HttpResponse.json({ nonsense: true });
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
      });

      await expect(client.getStatus()).rejects.toThrow(MalformedUpstreamError);
      expect(attempts).toBe(1);
    });

    it("preserves datapoint fields it does not know about", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1", () =>
          HttpResponse.json([
            {
              ...mockShotData,
              datapoints: { ...mockShotData.datapoints, customField: [1, 2] },
            },
          ]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const shot = await client.getShotData("1");

      expect(shot.datapoints.customField).toEqual([1, 2]);
    });

    it("stringifies a numeric shot id", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1", () =>
          HttpResponse.json([{ ...mockShotData, id: 1706547890 }]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const shot = await client.getShotData("1");

      expect(shot.id).toBe("1706547890");
    });
  });
});
