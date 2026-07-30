import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mockLatestShotResponse,
  mockMachineStatus,
  mockShotData,
  mockShotWithTimeStop,
} from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import { handleToolCall } from "./server";
import { mockServer } from "./test-setup";

describe("tool dispatch", () => {
  beforeEach(() => {
    // Reset client before each test to ensure fresh MSW interception
    resetClient({ initialDelayMs: 1 });
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.json([mockMachineStatus]),
      ),
      http.get("http://gaggiuino.local/api/shots/latest", () =>
        HttpResponse.json([mockLatestShotResponse]),
      ),
      http.get("http://gaggiuino.local/api/shots/1706547890", () =>
        HttpResponse.json([mockShotData]),
      ),
    );
  });

  describe("get_status", () => {
    it("returns formatted machine status", async () => {
      const result = await handleToolCall("get_status", {});
      expect(result.text).toContain("Gaggiuino Machine Status");
      expect(result.text).toContain("Temperature: 91");
      expect(result.text).toContain("Profile: Zer0");
    });

    it("returns structured content alongside the text", async () => {
      const result = await handleToolCall("get_status", {});
      expect(result.structuredContent).toEqual({
        brewActive: false,
        pressureBar: 0,
        profileName: "Zer0",
        steamActive: false,
        targetTemperatureC: 93,
        temperatureC: 91,
        upTimeSec: 3600,
        waterLevelPercent: 85,
        weightG: 0,
      });
    });

    it("reports engaged switches as booleans", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json([
            { ...mockMachineStatus, brewSwitchState: "true", weight: 12.5 },
          ]),
        ),
      );
      const result = await handleToolCall("get_status", {});
      expect(result.structuredContent).toMatchObject({
        brewActive: true,
        weightG: 12.5,
      });
      expect(result.text).toContain("Brew Switch: ON");
    });

    it("renders absent optional fields as N/A", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json([{ pressure: 0, temperature: 91 }]),
        ),
      );
      const result = await handleToolCall("get_status", {});
      expect(result.text).toContain("Profile: N/A");
      expect(result.text).toContain("Water Level: N/A%");
      expect(result.structuredContent).toMatchObject({
        profileName: null,
        upTimeSec: null,
      });
    });
  });

  describe("get_latest_shot_id", () => {
    it("returns latest shot ID", async () => {
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.text).toContain("1706547890");
      expect(result.structuredContent).toMatchObject({
        shotId: "1706547890",
      });
    });

    it("folds the shot's headline numbers into the same answer", async () => {
      // "How was my last shot" used to cost two round trips: an id, then the
      // shot. The id is cached by the time get_shot_data asks for detail.
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.structuredContent?.summary).toMatchObject({
        finalWeightG: 38.1,
        peakPressureBar: 9.1,
        profileName: "LMD 9-8 v1.5 (milk)",
        shotId: "1706547890",
      });
      expect(result.text).toContain("Peak Pressure: 9.1 bar");
    });

    it("still returns the id when the shot record cannot be read", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.json({ error: "gone" }, { status: 404 }),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        shotId: "1706547890",
        summary: null,
      });
      expect(result.text).toContain("Latest shot ID: 1706547890");
    });

    it("returns message when no shot available", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{}]),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.text).toContain("No shot history available");
      expect(result.structuredContent).toEqual({ shotId: null, summary: null });
    });

    it("stringifies a numeric id from the machine", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{ lastShotId: 1706547890 }]),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.structuredContent?.shotId).toBe("1706547890");
    });
  });

  describe("list_recent_shots", () => {
    /** A machine holding exactly these ids, 404 for everything else. */
    function machineWith(ids: number[]) {
      const present = new Set(ids.map(String));
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{ lastShotId: String(Math.max(...ids)) }]),
        ),
        http.get("http://gaggiuino.local/api/shots/:id", ({ params }) => {
          const id = String(params.id);
          if (!present.has(id)) {
            return HttpResponse.json({ error: "not found" }, { status: 404 });
          }
          return HttpResponse.json([{ ...mockShotData, id }]);
        }),
      );
    }

    it("summarizes several shots in one call", async () => {
      machineWith([1, 2, 3, 4, 5]);
      const result = await handleToolCall("list_recent_shots", { limit: 3 });
      const shots = result.structuredContent?.shots as Array<{
        shotId: string;
      }>;

      expect(shots.map((shot) => shot.shotId)).toEqual(["5", "4", "3"]);
      expect(result.text).toContain("Recent shots");
      expect(result.text).toContain("peak 9.1 bar");
    });

    it("defaults to five shots", async () => {
      machineWith([1, 2, 3, 4, 5, 6, 7]);
      const result = await handleToolCall("list_recent_shots", {});
      expect(result.structuredContent?.shots).toHaveLength(5);
    });

    it("returns fewer shots than asked for rather than failing", async () => {
      machineWith([9]);
      const result = await handleToolCall("list_recent_shots", { limit: 5 });
      expect(result.structuredContent?.shots).toHaveLength(1);
    });

    it("says so plainly when there is nothing to list", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{}]),
        ),
      );
      const result = await handleToolCall("list_recent_shots", { limit: 5 });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("No shots found");
    });

    it("pages further back from a given id", async () => {
      machineWith([1, 2, 3, 4, 5]);
      const result = await handleToolCall("list_recent_shots", {
        before: "4",
        limit: 2,
      });
      const shots = result.structuredContent?.shots as Array<{
        shotId: string;
      }>;

      expect(shots.map((shot) => shot.shotId)).toEqual(["3", "2"]);
      expect(result.text).toContain("before #4");
    });

    it("refuses a limit that would flood the machine", async () => {
      const result = await handleToolCall("list_recent_shots", { limit: 500 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("limit");
    });
  });

  describe("get_previous_shot_json", () => {
    it("resolves the real previous shot across a gap", async () => {
      // The compare button used to ask for `id - 1`, which is the previous
      // shot only on a machine that has never deleted one.
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/9", () =>
          HttpResponse.json({ error: "not found" }, { status: 404 }),
        ),
        http.get("http://gaggiuino.local/api/shots/8", () =>
          HttpResponse.json([{ ...mockShotData, id: "8" }]),
        ),
      );

      const result = await handleToolCall("get_previous_shot_json", {
        shot_id: "10",
      });
      expect(JSON.parse(result.text).id).toBe("8");
    });

    it("explains itself when there is no older shot", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/:id", () =>
          HttpResponse.json({ error: "not found" }, { status: 404 }),
        ),
      );

      const result = await handleToolCall("get_previous_shot_json", {
        shot_id: "3",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no shot older than #3");
    });

    it("has no older shot to offer for the very first one", async () => {
      const result = await handleToolCall("get_previous_shot_json", {
        shot_id: "1",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("get_shot_data", () => {
    it("returns formatted shot summary", async () => {
      const result = await handleToolCall("get_shot_data", {
        shot_id: "1706547890",
      });
      expect(result.text).toContain("Shot #1706547890");
      expect(result.text).toContain("LMD 9-8 v1.5 (milk)");
    });

    it("returns the summary as structured content with units normalized", async () => {
      const result = await handleToolCall("get_shot_data", {
        shot_id: "1706547890",
      });
      expect(result.structuredContent).toMatchObject({
        outcomeMetrics: {
          finalWeightG: 38.1,
          peakPressureBar: 9.1,
          profileName: "LMD 9-8 v1.5 (milk)",
          shotId: "1706547890",
          targetWeightG: 38,
          totalDurationSec: 34,
        },
      });
    });

    it("accepts a shot id sent as a number", async () => {
      const result = await handleToolCall("get_shot_data", {
        shot_id: 1706547890,
      });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Shot #1706547890");
    });
  });

  describe("get_shot_raw_data", () => {
    it("returns raw shot datapoints", async () => {
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547890",
      });
      expect(result.text).toContain("Shot #1706547890 Raw Data");
      expect(result.text).toContain("LMD 9-8 v1.5 (milk)");
      expect(result.text).toContain("Datapoints:");
    });

    it("declares no output schema, so returns no structured content", async () => {
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547890",
      });
      expect(result.structuredContent).toBeUndefined();
    });

    it("shows time stop condition when set", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547894", () =>
          HttpResponse.json([mockShotWithTimeStop]),
        ),
      );
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547894",
      });
      expect(result.text).toContain("time: 30s");
    });

    it("outputs non-scaled datapoints without normalization", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547894", () =>
          HttpResponse.json([mockShotWithTimeStop]),
        ),
      );
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547894",
      });
      expect(result.text).toContain("customField: [1,2,3,4]");
    });
  });

  describe("list_profiles", () => {
    it("returns list of available profiles", async () => {
      const result = await handleToolCall("list_profiles", {});
      expect(result.text).toContain("Zer0");
      expect(result.text).toContain("Adaptive");
    });

    it("returns every profile in full as structured content", async () => {
      const result = await handleToolCall("list_profiles", {});
      const { profiles } = result.structuredContent as {
        profiles: Array<Record<string, unknown>>;
      };
      expect(profiles.length).toBeGreaterThan(1);
      expect(profiles[0]).toMatchObject({
        id: expect.any(String),
        description: expect.any(String),
        roastLevels: expect.any(Array),
      });
    });
  });

  describe("get_profile_info", () => {
    it("returns profile details", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "zer0",
      });
      expect(result.text).toContain("Zer0");
      expect(result.text).toContain("flow");
      expect(result.text).toContain("Description");
      expect(result.structuredContent).toMatchObject({
        id: "zer0",
        name: "Zer0",
      });
    });

    it("returns an actionable error result for an unknown profile", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "nonexistent",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("nonexistent");
      expect(result.text).toContain("Available ids:");
      expect(result.structuredContent).toBeUndefined();
    });
  });

  describe("get_dial_in_guidance", () => {
    it("returns dial-in guidance with profiles", async () => {
      const result = await handleToolCall("get_dial_in_guidance", {});
      expect(result.text).toContain("dialling in");
      expect(result.text).toContain("Available Profiles");
    });
  });

  describe("view_shot_graph", () => {
    it("returns shot summary text as fallback", async () => {
      const result = await handleToolCall("view_shot_graph", {
        shot_id: "1706547890",
      });
      expect(result.text).toContain("Shot #1706547890");
      expect(result.text).toContain("LMD 9-8 v1.5 (milk)");
    });

    it("appends the comparison shot when one is given", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547894", () =>
          HttpResponse.json([mockShotWithTimeStop]),
        ),
      );
      const result = await handleToolCall("view_shot_graph", {
        compare_shot_id: "1706547894",
        shot_id: "1706547890",
      });
      expect(result.text).toContain("Comparison shot:");
      expect(result.text).toContain("Time Stop Profile");
      expect(result.text).toContain("with comparison overlay");
    });

    it("costs one upstream fetch per shot, not one per caller", async () => {
      // Rendering a graph is two reads of the same shot: this tool builds the
      // text summary, then the app it renders calls get_shot_raw_json for the
      // same id. With a comparison overlay that was four round trips to an
      // ESP32 for two shots that had already finished.
      let primary = 0;
      let comparison = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () => {
          primary += 1;
          return HttpResponse.json([mockShotData]);
        }),
        http.get("http://gaggiuino.local/api/shots/1706547894", () => {
          comparison += 1;
          return HttpResponse.json([mockShotWithTimeStop]);
        }),
      );

      await handleToolCall("view_shot_graph", {
        compare_shot_id: "1706547894",
        shot_id: "1706547890",
      });
      await handleToolCall("get_shot_raw_json", { shot_id: "1706547890" });
      await handleToolCall("get_shot_raw_json", { shot_id: "1706547894" });

      expect(primary).toBe(1);
      expect(comparison).toBe(1);
    });
  });

  describe("get_shot_raw_json", () => {
    it("returns raw shot data as JSON string", async () => {
      const result = await handleToolCall("get_shot_raw_json", {
        shot_id: "1706547890",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.id).toBe("1706547890");
      expect(parsed.datapoints.pressure).toBeDefined();
      expect(Array.isArray(parsed.datapoints.pressure)).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects a missing required argument, naming the field", async () => {
      const result = await handleToolCall("get_shot_data", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Invalid arguments for get_shot_data");
      expect(result.text).toContain("shot_id");
    });

    it("rejects a mistyped argument, naming the field", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: { nope: true },
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("profile_id");
    });

    it("rejects an empty string where an id is required", async () => {
      const result = await handleToolCall("get_shot_data", { shot_id: "" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("shot_id");
    });

    it("never reaches the machine when arguments are invalid", async () => {
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/*", () => {
          requests += 1;
          return HttpResponse.json([mockShotData]);
        }),
      );
      await handleToolCall("get_shot_raw_json", {});
      expect(requests).toBe(0);
    });
  });

  describe("upstream failures", () => {
    it("maps a 404 on a shot to a not-found result naming the id", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/999", () =>
          HttpResponse.json({ error: "no" }, { status: 404 }),
        ),
      );
      const result = await handleToolCall("get_shot_data", { shot_id: "999" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("No shot with id '999'");
      expect(result.text).toContain("get_latest_shot_id");
    });

    it("maps an empty upstream payload to a malformed-response result", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.json([]),
        ),
      );
      const result = await handleToolCall("get_shot_data", {
        shot_id: "1706547890",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("could not understand");
    });

    it("maps a partial shot payload to a malformed-response result", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.json([{ id: "1706547890" }]),
        ),
      );
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547890",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("could not understand");
      expect(result.text).toContain("duration");
    });

    it("maps an unreachable machine to a check-the-machine result", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.error(),
        ),
      );
      const result = await handleToolCall("get_status", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Could not reach the Gaggiuino machine");
    });

    it("maps a 5xx to a machine-fault result", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json({ error: "boom" }, { status: 503 }),
        ),
      );
      const result = await handleToolCall("get_status", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("returned HTTP 503");
    });

    it("maps a 404 on a non-shot endpoint to a firmware hint", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json({ error: "no" }, { status: 404 }),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no endpoint at /api/shots/latest");
    });
  });

  describe("unknown tool", () => {
    it("throws error for unknown tool", async () => {
      await expect(handleToolCall("unknown_tool", {})).rejects.toThrow(
        "Unknown tool: unknown_tool",
      );
    });
  });
});
