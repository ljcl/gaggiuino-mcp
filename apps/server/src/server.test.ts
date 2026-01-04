import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mockLatestShotResponse,
  mockMachineStatus,
  mockShotData,
  mockShotWithTimeStop,
} from "./__fixtures__/api-responses";
import { handleToolCall, resetClient } from "./server";
import { mockServer } from "./test-setup";

describe("MCP Server Tools", () => {
  beforeEach(() => {
    // Reset client before each test to ensure fresh MSW interception
    resetClient();
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
      expect(result).toContain("Gaggiuino Machine Status");
      expect(result).toContain("Temperature: 91");
      expect(result).toContain("Profile: Zer0");
    });
  });

  describe("get_latest_shot_id", () => {
    it("returns latest shot ID", async () => {
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result).toContain("1706547890");
    });

    it("returns message when no shot available", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/latest", () =>
          HttpResponse.json([{}]),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result).toContain("No shot history available");
    });
  });

  describe("get_shot_data", () => {
    it("returns formatted shot summary", async () => {
      const result = await handleToolCall("get_shot_data", {
        shot_id: "1706547890",
      });
      expect(result).toContain("Shot #1706547890");
      expect(result).toContain("LMD 9-8 v1.5 (milk)");
    });
  });

  describe("get_shot_raw_data", () => {
    it("returns raw shot datapoints", async () => {
      const result = await handleToolCall("get_shot_raw_data", {
        shot_id: "1706547890",
      });
      expect(result).toContain("Shot #1706547890 Raw Data");
      expect(result).toContain("LMD 9-8 v1.5 (milk)");
      expect(result).toContain("Datapoints:");
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
      expect(result).toContain("time: 30s");
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
      expect(result).toContain("customField: [1,2,3,4]");
    });
  });

  describe("list_profiles", () => {
    it("returns list of available profiles", async () => {
      const result = await handleToolCall("list_profiles", {});
      expect(result).toContain("Zer0");
      expect(result).toContain("Adaptive");
    });
  });

  describe("get_profile_info", () => {
    it("returns profile details", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "zer0",
      });
      expect(result).toContain("Zer0");
      expect(result).toContain("flow");
      expect(result).toContain("Description");
    });

    it("returns error for unknown profile", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "nonexistent",
      });
      expect(result).toContain("not found");
    });
  });

  describe("get_dial_in_guidance", () => {
    it("returns dial-in guidance with profiles", async () => {
      const result = await handleToolCall("get_dial_in_guidance", {});
      expect(result).toContain("dialling in");
      expect(result).toContain("Available Profiles");
    });
  });

  describe("view_shot_graph", () => {
    it("returns shot summary text as fallback", async () => {
      const result = await handleToolCall("view_shot_graph", {
        shot_id: "1706547890",
      });
      expect(result).toContain("Shot #1706547890");
      expect(result).toContain("LMD 9-8 v1.5 (milk)");
    });
  });

  describe("get_shot_raw_json", () => {
    it("returns raw shot data as JSON string", async () => {
      const result = await handleToolCall("get_shot_raw_json", {
        shot_id: "1706547890",
      });
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe("1706547890");
      expect(parsed.datapoints.pressure).toBeDefined();
      expect(Array.isArray(parsed.datapoints.pressure)).toBe(true);
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
