import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockLatestShotResponse,
  mockMachineSettingsFromDocs,
  mockMachineStatus,
  mockProfileDefinition,
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

    it("reports a machine that vanished mid-call instead of a bare id", async () => {
      // A 404 costs the summary and keeps the id; losing the machine entirely
      // is worth telling the user about, because the id is stale news by then.
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.error(),
        ),
      );
      const result = await handleToolCall("get_latest_shot_id", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Could not reach the Gaggiuino machine");
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
    /** What the machine reports it is holding. */
    function machineProfiles(profiles: Array<Record<string, unknown>>) {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json(profiles),
        ),
      );
    }

    function profilesOf(result: { structuredContent?: unknown }) {
      return (
        result.structuredContent as {
          profiles: Array<Record<string, unknown>>;
        }
      ).profiles;
    }

    it("returns list of available profiles", async () => {
      machineProfiles([{ id: "15", name: "Zer0" }]);
      const result = await handleToolCall("list_profiles", {});
      expect(result.text).toContain("Zer0");
      expect(result.text).toContain("Adaptive");
    });

    it("never fetches a per-profile definition", async () => {
      // The N+1 guard. `get_profile_info` reads /api/profile/{id}; doing the
      // same from a list would be one sequential round trip per profile to a
      // device that serves one request at a time.
      let asked = 0;
      machineProfiles([
        { id: "15", name: "Zer0" },
        { id: "16", name: "Londinium" },
        { id: "17", name: "Blooming" },
      ]);
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/:id", () => {
          asked += 1;
          return HttpResponse.json({ name: "should not be reached" });
        }),
      );

      await handleToolCall("list_profiles", {});
      expect(asked).toBe(0);
    });

    it("returns every profile in full as structured content", async () => {
      machineProfiles([{ id: "15", name: "Zer0" }]);
      const result = await handleToolCall("list_profiles", {});
      const profiles = profilesOf(result);
      expect(profiles.length).toBeGreaterThan(1);
      expect(profiles[0]).toMatchObject({
        description: expect.any(String),
        id: expect.any(String),
        roastLevels: expect.any(Array),
      });
    });

    it("enriches a machine profile with the documentation for its name", async () => {
      machineProfiles([{ id: "15", name: "Zer0" }]);
      const result = await handleToolCall("list_profiles", {});
      const zer0 = profilesOf(result).find(
        (profile) => profile.name === "Zer0",
      );

      expect(zer0).toMatchObject({
        documented: true,
        id: "zer0",
        machineProfileId: "15",
        onMachine: true,
      });
      expect(zer0?.description).toEqual(expect.any(String));
      expect(result.structuredContent?.source).toBe("machine");
    });

    it("lists a profile the user built on the machine, undocumented", async () => {
      // The case the whole merge exists for: real, selectable, and invisible
      // to a server that only ever read its own YAML.
      machineProfiles([{ id: "42", name: "Sunday Filter Experiment" }]);
      const result = await handleToolCall("list_profiles", {});
      const custom = profilesOf(result).find(
        (profile) => profile.name === "Sunday Filter Experiment",
      );

      expect(custom).toMatchObject({
        description: null,
        documented: false,
        machineProfileId: "42",
        onMachine: true,
        roastLevels: [],
        type: null,
      });
    });

    it("flags a documented profile the machine is not holding", async () => {
      machineProfiles([{ id: "15", name: "Zer0" }]);
      const result = await handleToolCall("list_profiles", {});
      const absent = profilesOf(result).filter(
        (profile) => profile.onMachine === false,
      );

      expect(absent.length).toBeGreaterThan(0);
      expect(result.text).toContain("Not currently on the machine");
      expect(String(result.structuredContent?.note)).toContain(
        "not currently on the machine",
      );
    });

    it("matches names case- and whitespace-insensitively", async () => {
      machineProfiles([{ id: "15", name: "  zer0  " }]);
      const result = await handleToolCall("list_profiles", {});
      const documented = profilesOf(result).filter(
        (profile) => profile.machineProfileId === "15",
      );

      expect(documented[0]).toMatchObject({ documented: true, id: "zer0" });
    });

    it("accepts a firmware that wraps the list under a key", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json({ profiles: [{ id: "15", name: "Zer0" }] }),
        ),
      );
      const result = await handleToolCall("list_profiles", {});
      expect(result.structuredContent?.source).toBe("machine");
    });

    it("falls back to bundled documentation and says why", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.error(),
        ),
      );
      const result = await handleToolCall("list_profiles", {});

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.source).toBe("documentation");
      // The upstream diagnostic is reused rather than replaced with a generic
      // "unavailable", so the user is told what to check.
      expect(String(result.structuredContent?.note)).toContain(
        "Could not reach the Gaggiuino machine",
      );
      // "We did not check" is not the same claim as "it is not there".
      expect(profilesOf(result).every((p) => p.onMachine === null)).toBe(true);
    });
  });

  describe("get_profile_info", () => {
    beforeEach(() => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json([{ id: "15", name: "Zer0" }]),
        ),
      );
    });

    it("returns profile details", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "zer0",
      });
      expect(result.text).toContain("Zer0");
      expect(result.text).toContain("flow");
      expect(result.text).toContain("Description");
      expect(result.structuredContent).toMatchObject({
        id: "zer0",
        machineProfileId: "15",
        name: "Zer0",
      });
    });

    it("resolves a machine profile id as well as a documented one", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "15",
      });
      expect(result.structuredContent).toMatchObject({ name: "Zer0" });
    });

    it("describes an undocumented machine profile without pretending", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json([{ id: "42", name: "Sunday Filter Experiment" }]),
        ),
      );
      const result = await handleToolCall("get_profile_info", {
        profile_id: "42",
      });

      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("created on the machine");
      expect(result.structuredContent).toMatchObject({ documented: false });
    });

    it("says when a documented profile is not loaded on the machine", async () => {
      const result = await handleToolCall("get_profile_info", {
        profile_id: "adaptive",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Not currently on the machine");
      expect(result.structuredContent).toMatchObject({ onMachine: false });
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

    describe("the machine's own definition", () => {
      function serveDefinition(id: string, body: object | null, status = 200) {
        mockServer.use(
          http.get(`http://gaggiuino.local/api/profile/${id}`, () =>
            status === 200
              ? HttpResponse.json(body)
              : new HttpResponse(null, { status }),
          ),
        );
      }

      it("reads the machine's definition alongside the documentation", async () => {
        serveDefinition("15", mockProfileDefinition);
        const result = await handleToolCall("get_profile_info", {
          profile_id: "zer0",
        });

        expect(result.text).toContain("## Machine definition");
        expect(result.text).toContain("Preinfusion");
        expect(result.structuredContent).toMatchObject({
          definition: { waterTemperature: 93 },
        });
      });

      it("answers what an undocumented profile actually does", async () => {
        // The headline case. Before this the user's own profile came back as a
        // row of nulls and a suggestion to go pull a shot with it.
        mockServer.use(
          http.get("http://gaggiuino.local/api/profiles/all", () =>
            HttpResponse.json([{ id: "42", name: "Sunday Filter Experiment" }]),
          ),
        );
        serveDefinition("42", mockProfileDefinition);
        const result = await handleToolCall("get_profile_info", {
          profile_id: "42",
        });

        expect(result.structuredContent).toMatchObject({
          definition: { waterTemperature: 93 },
          documented: false,
        });
        expect(result.text).toContain("Preinfusion");
      });

      it("degrades to the documentation when the firmware has no export", async () => {
        serveDefinition("15", null, 404);
        const result = await handleToolCall("get_profile_info", {
          profile_id: "zer0",
        });

        expect(result.isError).toBeFalsy();
        // Everything the tool did before still works.
        expect(result.text).toContain("Zer0");
        expect(result.text).toContain("Description");
        expect(result.text).toContain("predates");
        expect(result.text).toContain("removed since");
        expect(result.structuredContent).toMatchObject({ definition: null });
      });

      it("degrades rather than failing when the machine faults", async () => {
        serveDefinition("15", null, 503);
        const result = await handleToolCall("get_profile_info", {
          profile_id: "zer0",
        });

        expect(result.isError).toBeFalsy();
        expect(result.text).toContain("HTTP 503");
        expect(result.structuredContent).toMatchObject({ definition: null });
      });

      it("does not ask the machine for a profile it does not hold", async () => {
        let asked = 0;
        mockServer.use(
          http.get("http://gaggiuino.local/api/profile/:id", () => {
            asked += 1;
            return HttpResponse.json(mockProfileDefinition);
          }),
        );
        const result = await handleToolCall("get_profile_info", {
          profile_id: "adaptive",
        });

        expect(asked).toBe(0);
        expect(result.text).toContain("is not on the machine");
      });
    });
  });

  describe("get_machine_settings", () => {
    it("prints whatever the machine exposes, nested", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.json([
            {
              boiler: { offsetTemp: 8, steamSetPoint: 155 },
              brew: { basketPrefill: true },
            },
          ]),
        ),
      );
      const result = await handleToolCall("get_machine_settings", {});

      expect(result.text).toContain("steamSetPoint: 155");
      expect(result.text).toContain("offsetTemp: 8");
      expect(result.text).toContain("basketPrefill: true");
    });

    it("passes through a field this server has never heard of", async () => {
      // A schema that modelled the known knobs would drop exactly the field a
      // user asking about a new firmware setting wants to see.
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.json([{ someFutureKnob: 3 }]),
        ),
      );
      const result = await handleToolCall("get_machine_settings", {});
      expect(result.text).toContain("someFutureKnob: 3");
    });

    it("reports an unreachable machine rather than inventing defaults", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/settings", () =>
          HttpResponse.error(),
        ),
      );
      const result = await handleToolCall("get_machine_settings", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Could not reach the Gaggiuino machine");
    });

    describe("credential redaction", () => {
      function serveSettings(body: object) {
        // `/api/settings` is cached for MACHINE_CONFIG_TTL_MS, so a test that
        // serves two different payloads has to drop the client between them or
        // the second read is answered from the first.
        resetClient({ initialDelayMs: 1 });
        mockServer.use(
          http.get("http://gaggiuino.local/api/settings", () =>
            HttpResponse.json([body]),
          ),
        );
      }

      it("never prints the machine's upload tokens", async () => {
        serveSettings(mockMachineSettingsFromDocs);
        const result = await handleToolCall("get_machine_settings", {});

        expect(result.text).not.toContain("abc123xyz");
        expect(result.text).not.toContain("def456uvw");
        // The keys surviving is what makes this redaction and not dropping —
        // the user still learns the setting exists.
        expect(result.text).toContain(`sprofilerToken: ${"[hidden]"}`);
        expect(result.text).toContain(`visualizerToken: ${"[hidden]"}`);
      });

      it("hides a credential this server has never heard of", async () => {
        // The whole reason the rule is on value type rather than field name.
        // Any name-denylist implementation passes every other test here and
        // fails this one.
        serveSettings({ system: { futureUploadKey: "sk-live-9a8b7c6d5e" } });
        const result = await handleToolCall("get_machine_settings", {});

        expect(result.text).not.toContain("sk-live-9a8b7c6d5e");
        expect(result.text).toContain("futureUploadKey: [hidden]");
      });

      it("hides everything under a section whose own name reads as a secret", async () => {
        serveSettings({ credentials: { visualizer: "plaintext-value" } });
        const result = await handleToolCall("get_machine_settings", {});

        expect(result.text).not.toContain("plaintext-value");
        expect(result.text).toContain("visualizer: [hidden]");
      });

      it("still prints every setting that is not a credential", async () => {
        serveSettings(mockMachineSettingsFromDocs);
        const result = await handleToolCall("get_machine_settings", {});

        expect(result.text).toContain("pumpFlowAtZero: 0.5");
        expect(result.text).toContain("timezoneOffsetMinutes: -300");
        expect(result.text).toContain("releaseChannel: 0");
        expect(result.text).toContain("mqttPort: 1883");
        expect(result.text).toContain("mqttEnabled: false");
        expect(result.text).toContain("mqttTopicPrefix: gaggiuino");
        expect(result.text).toContain("steamSetPoint: 145");
        // This firmware's stringly-typed booleans and numbers are values, not
        // secrets, and must survive the filter.
        expect(result.text).toContain("forcePredictive: false");
        expect(result.text).toContain("hwScalesEnabled: true");
        expect(result.text).toContain("coreVersion: a06f97fd");
      });

      it("distinguishes an unset credential from a withheld one", async () => {
        serveSettings({ system: { mqttPassword: "" } });
        const empty = await handleToolCall("get_machine_settings", {});
        expect(empty.text).toContain("mqttPassword: (not set)");

        serveSettings({ system: { mqttPassword: "hunter2" } });
        const set = await handleToolCall("get_machine_settings", {});
        expect(set.text).toContain("mqttPassword: [hidden]");
        expect(set.text).not.toContain("hunter2");
      });

      it("explains the redaction once, and only when something was hidden", async () => {
        serveSettings(mockMachineSettingsFromDocs);
        const hidden = await handleToolCall("get_machine_settings", {});
        expect(hidden.text.match(/withheld by this MCP server/g)?.length).toBe(
          1,
        );

        serveSettings({ boiler: { steamSetPoint: 145 } });
        const clean = await handleToolCall("get_machine_settings", {});
        expect(clean.text).not.toContain("withheld by this MCP server");
      });
    });
  });

  describe("get_maintenance_status", () => {
    function serveMaintenance(body: object | null, status = 200) {
      resetClient({ initialDelayMs: 1 });
      mockServer.use(
        http.get("http://gaggiuino.local/api/maintenance", () =>
          status === 200
            ? HttpResponse.json(body)
            : new HttpResponse(null, { status }),
        ),
      );
    }

    it("summarizes the machine's own service log", async () => {
      serveMaintenance({
        lastBackflushTimestamp: 1753000000,
        lastDescaleTimestamp: 1753900000,
        shotsSinceBackflush: 10,
        shotsSinceDescale: 42,
      });
      const result = await handleToolCall("get_maintenance_status", {});

      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("## Descale");
      expect(result.text).toContain("Shots since: 42");
      // Order is the machine's own key order, not this server's preference.
      expect(result.structuredContent).toMatchObject({
        services: [
          { service: "backflush", shotsSince: 10 },
          { service: "descale", shotsSince: 42 },
        ],
      });
    });

    it("unwraps a record the firmware wrapped in an array", async () => {
      serveMaintenance([{ lastDescaleTimestamp: 1753900000 }]);
      const result = await handleToolCall("get_maintenance_status", {});
      expect(result.text).toContain("## Descale");
    });

    it("reads a 404 as firmware without a service log, not as a broken machine", async () => {
      serveMaintenance(null, 404);
      const result = await handleToolCall("get_maintenance_status", {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("does not track service history");
      // The generic 404 text reads as a bug report; this one is an answer.
      expect(result.text).not.toContain("no endpoint at");
    });

    it("still reports a 503 as a machine fault", async () => {
      serveMaintenance(null, 503);
      const result = await handleToolCall("get_maintenance_status", {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("HTTP 503");
    });

    it("still reports an unreachable machine as unreachable", async () => {
      resetClient({ initialDelayMs: 1 });
      mockServer.use(
        http.get("http://gaggiuino.local/api/maintenance", () =>
          HttpResponse.error(),
        ),
      );
      const result = await handleToolCall("get_maintenance_status", {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Could not reach the Gaggiuino machine");
    });

    it("rejects a body that is not a record", async () => {
      serveMaintenance([]);
      const result = await handleToolCall("get_maintenance_status", {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("/api/maintenance");
    });
  });

  describe("select_profile", () => {
    // `vi.stubEnv` outlives the test that set it, and this suite shares a
    // process with the auth tests — leaving MCP_AUTH_TOKEN set would silently
    // change what they are testing.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** What the machine holds, plus a record of what it was asked to select. */
    function machineHolding(profiles: Array<Record<string, unknown>>) {
      const selected: string[] = [];
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json(profiles),
        ),
        http.post(
          "http://gaggiuino.local/api/profile-select/:id",
          ({ params }) => {
            selected.push(String(params.id));
            return HttpResponse.text("OK");
          },
        ),
      );
      return selected;
    }

    it("refuses when the server has no auth token", async () => {
      // The gate is the whole reason this tool waited on #19: an open /mcp
      // over a tunnel would let anyone drive the machine.
      vi.stubEnv("MCP_AUTH_TOKEN", "");
      machineHolding([{ id: "15", name: "Zer0" }]);

      const result = await handleToolCall("select_profile", {
        profile_id: "zer0",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("MCP_AUTH_TOKEN");
    });

    describe("with the endpoint authenticated", () => {
      beforeEach(() => {
        vi.stubEnv("MCP_AUTH_TOKEN", "test-secret");
      });

      it("selects by documented id, posting the machine's own id", async () => {
        const selected = machineHolding([{ id: "15", name: "Zer0" }]);

        const result = await handleToolCall("select_profile", {
          profile_id: "zer0",
        });
        expect(result.isError).toBeFalsy();
        expect(selected).toEqual(["15"]);
        expect(result.text).toContain("Zer0");
      });

      it("selects by the machine's own profile id", async () => {
        const selected = machineHolding([{ id: "15", name: "Zer0" }]);

        await handleToolCall("select_profile", { profile_id: "15" });
        expect(selected).toEqual(["15"]);
      });

      it("accepts an ack that is not JSON", async () => {
        // The reply format is a firmware detail. Parsing it would turn a
        // successful selection into a failure, and then retry it.
        const selected = machineHolding([{ id: "15", name: "Zer0" }]);
        mockServer.use(
          http.post("http://gaggiuino.local/api/profile-select/15", () => {
            selected.push("15");
            return new HttpResponse("done", { status: 200 });
          }),
        );

        const result = await handleToolCall("select_profile", {
          profile_id: "15",
        });
        expect(result.isError).toBeFalsy();
        expect(selected).toEqual(["15"]);
      });

      it("will not select a documented profile the machine does not hold", async () => {
        machineHolding([{ id: "15", name: "Zer0" }]);

        const result = await handleToolCall("select_profile", {
          profile_id: "adaptive",
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not loaded on the machine");
      });

      it("refuses rather than guessing when the machine is unreachable", async () => {
        mockServer.use(
          http.get("http://gaggiuino.local/api/profiles/all", () =>
            HttpResponse.error(),
          ),
        );

        const result = await handleToolCall("select_profile", {
          profile_id: "zer0",
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("could not be reached");
      });

      it("names the id it could not find", async () => {
        machineHolding([{ id: "15", name: "Zer0" }]);

        const result = await handleToolCall("select_profile", {
          profile_id: "not-a-profile",
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("Available ids:");
      });

      it("blames the id, not the firmware, on a 404 from the machine", async () => {
        mockServer.use(
          http.get("http://gaggiuino.local/api/profiles/all", () =>
            HttpResponse.json([{ id: "99", name: "Zer0" }]),
          ),
          http.post("http://gaggiuino.local/api/profile-select/99", () =>
            HttpResponse.json({ error: "no such profile" }, { status: 404 }),
          ),
        );

        const result = await handleToolCall("select_profile", {
          profile_id: "99",
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("no profile with id '99'");
        expect(result.text).not.toContain("firmware version");
      });
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
