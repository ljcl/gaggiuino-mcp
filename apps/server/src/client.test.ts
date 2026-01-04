import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockMachineStatus, mockShotData } from "./__fixtures__/api-responses";
import { createClient } from "./client";
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

      await expect(client.getStatus()).rejects.toThrow("HTTP 404");
      expect(attempts).toBe(1);
    });
  });
});
