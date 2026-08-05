import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  mockMachineStatus,
  mockMachineStatusFromHardware,
  mockProfileDefinition,
  mockProfileDefinitionFull,
  mockShotData,
} from "./__fixtures__/api-responses";
import {
  createClient,
  getUpstreamHealth,
  MACHINE_CONFIG_TTL_MS,
  resetClient,
  SHOT_TTL_MS,
} from "./client";
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

    it("retries a 503 and succeeds when the machine recovers", async () => {
      // The webserver on a microcontroller answers 503 while it is busy
      // writing a shot to flash. Treating that like a 404 — one attempt, then
      // give up — failed the call for a machine that was about to be fine.
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          if (attempts < 3) {
            return HttpResponse.json({ error: "busy" }, { status: 503 });
          }
          return HttpResponse.json([mockMachineStatus]);
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
      });
      const status = await client.getStatus();

      expect(attempts).toBe(3);
      expect(status.temperature).toBe(91);
    });

    it("reports a machine that only ever answers 503 as faulty, not absent", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () =>
          HttpResponse.json({ error: "busy" }, { status: 503 }),
        ),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
        maxRetries: 2,
      });

      // "Could not reach the machine, it may be powered off" would be wrong
      // advice for a machine that answered every single time.
      await expect(client.getStatus()).rejects.toThrow(UpstreamHttpError);
    });

    it("does not retry a 400", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          return HttpResponse.json({ error: "bad" }, { status: 400 });
        }),
      );

      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
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

  describe("overall deadline", () => {
    it("stops retrying once the budget is spent", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", async () => {
          attempts += 1;
          await delay(60);
          return HttpResponse.json([mockMachineStatus]);
        }),
      );

      // Three attempts at a 20ms timeout would be allowed by maxRetries; the
      // 50ms budget is what actually stops it, which is the bound a host feels.
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
        maxRetries: 5,
        overallTimeoutMs: 50,
        timeoutMs: 20,
      });

      await expect(client.getStatus()).rejects.toThrow(
        UpstreamUnreachableError,
      );
      expect(attempts).toBeLessThan(5);
    });

    it("does not sleep a backoff it has no budget for", async () => {
      let attempts = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          attempts += 1;
          return HttpResponse.error();
        }),
      );

      const started = Date.now();
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 5_000,
        maxRetries: 3,
        overallTimeoutMs: 100,
      });

      await expect(client.getStatus()).rejects.toThrow(
        UpstreamUnreachableError,
      );
      // One 5s backoff would blow the budget, so it is skipped entirely rather
      // than slept and then abandoned.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(attempts).toBe(1);
    });
  });

  describe("createProfile", () => {
    it("sends the profile as a JSON body with the documented content type", async () => {
      let body: unknown;
      let contentType: string | null = null;
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", async ({ request }) => {
          contentType = request.headers.get("content-type");
          body = await request.json();
          return HttpResponse.json({ id: 4, name: "18g Double" });
        }),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const created = await client.createProfile(mockProfileDefinition);

      expect(body).toEqual(mockProfileDefinition);
      expect(contentType).toBe("application/json");
      expect(created.id).toBe("4");
    });

    it("does not retry a 503, unlike every other call here", async () => {
      // The whole reason this endpoint has its own attempt budget. 503 is
      // retriable under isRetriableStatus — an ESP32 busy writing to flash —
      // which on a create is precisely when the write may already have landed.
      let attempts = 0;
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", () => {
          attempts += 1;
          return new HttpResponse(null, { status: 503 });
        }),
      );
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
      });

      await expect(client.createProfile({})).rejects.toThrow(UpstreamHttpError);
      expect(attempts).toBe(1);
    });

    it("does not retry a network failure either", async () => {
      let attempts = 0;
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", () => {
          attempts += 1;
          return HttpResponse.error();
        }),
      );
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
      });

      await expect(client.createProfile({})).rejects.toThrow(
        UpstreamUnreachableError,
      );
      expect(attempts).toBe(1);
    });

    it("keeps its attempt budget to itself", async () => {
      // maxAttempts is per-request, not a property of the client — a read on
      // the same client must still retry.
      let creates = 0;
      let reads = 0;
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", () => {
          creates += 1;
          return new HttpResponse(null, { status: 503 });
        }),
        http.get("http://gaggiuino.local/api/system/status", () => {
          reads += 1;
          return reads === 1
            ? new HttpResponse(null, { status: 503 })
            : HttpResponse.json([mockMachineStatus]);
        }),
      );
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        initialDelayMs: 1,
      });

      await expect(client.createProfile({})).rejects.toThrow();
      await client.getStatus();

      expect(creates).toBe(1);
      expect(reads).toBe(2);
    });

    it("carries the machine's own rejection text on the error", async () => {
      mockServer.use(
        http.post(
          "http://gaggiuino.local/api/profile",
          () => new HttpResponse("phases[0].target missing", { status: 422 }),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).rejects.toMatchObject({
        detail: "phases[0].target missing",
        status: 422,
      });
    });

    it("truncates a machine that answers with a whole error page", async () => {
      mockServer.use(
        http.post(
          "http://gaggiuino.local/api/profile",
          () => new HttpResponse("x".repeat(5000), { status: 500 }),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).rejects.toMatchObject({
        detail: `${"x".repeat(200)}…`,
      });
    });

    it("leaves the detail unset when the machine sends an empty body", async () => {
      mockServer.use(
        http.post(
          "http://gaggiuino.local/api/profile",
          () => new HttpResponse(null, { status: 500 }),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).rejects.toMatchObject({
        detail: undefined,
      });
    });

    it("resolves rather than throwing when a saved profile's ack is not JSON", async () => {
      // A SyntaxError here is not a MalformedUpstreamError, so it would fall
      // through to "the machine may be powered off" — said about a machine
      // that has just saved the profile.
      mockServer.use(
        http.post(
          "http://gaggiuino.local/api/profile",
          () => new HttpResponse("saved", { status: 200 }),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).resolves.toEqual({});
    });

    it("resolves when the ack is valid JSON of the wrong shape", async () => {
      // Same reasoning as the non-JSON case: the profile is already on the
      // machine, so nothing the ack says may turn this into a failure.
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", () =>
          HttpResponse.json("saved it"),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).resolves.toEqual({});
    });

    it("unwraps a created profile the firmware wrapped in an array", async () => {
      mockServer.use(
        http.post("http://gaggiuino.local/api/profile", () =>
          HttpResponse.json([{ id: 7, name: "Wrapped" }]),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.createProfile({})).resolves.toMatchObject({
        id: "7",
      });
    });
  });

  describe("getProfileDefinition", () => {
    it("reads the machine's export without rescaling anything", async () => {
      // A profile is not the shot time-series: nothing here is scaled by 10,
      // and every `time` is milliseconds. Getting this wrong writes a
      // five-millisecond ramp to the user's machine.
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/15", () =>
          HttpResponse.json(mockProfileDefinition),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const definition = await client.getProfileDefinition("15");

      expect(definition.waterTemperature).toBe(93);
      expect(definition.phases?.[0]?.target?.time).toBe(5000);
      expect(definition.globalStopConditions?.time).toBe(40000);
    });

    it("preserves a phase field this server has never heard of", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/15", () =>
          HttpResponse.json(mockProfileDefinitionFull),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const definition = await client.getProfileDefinition("15");

      expect(definition.phases?.[1]?.stopConditions?.someFutureCondition).toBe(
        7,
      );
    });

    it("url-encodes an id the machine minted with a space in it", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/my%20profile", () =>
          HttpResponse.json(mockProfileDefinition),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      await expect(
        client.getProfileDefinition("my profile"),
      ).resolves.toMatchObject({ name: "18g Double" });
    });

    it("rejects a body that is not a profile object", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/15", () =>
          HttpResponse.json("not a profile"),
        ),
      );
      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.getProfileDefinition("15")).rejects.toThrow(
        MalformedUpstreamError,
      );
    });

    it("serves a second read from cache, then re-reads past the ttl", async () => {
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/profile/15", () => {
          requests += 1;
          return HttpResponse.json(mockProfileDefinition);
        }),
      );
      let clock = 0;
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        now: () => clock,
      });

      await client.getProfileDefinition("15");
      await client.getProfileDefinition("15");
      expect(requests).toBe(1);

      clock += MACHINE_CONFIG_TTL_MS + 1;
      await client.getProfileDefinition("15");
      expect(requests).toBe(2);
    });
  });

  describe("caching", () => {
    it("fetches a completed shot once and serves the rest from cache", async () => {
      // This is the view_shot_graph path: the tool summarizes the shot, then
      // the rendered app asks for the same shot's raw JSON.
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () => {
          requests += 1;
          return HttpResponse.json([mockShotData]);
        }),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      const first = await client.getShotData("1706547890");
      const second = await client.getShotData("1706547890");

      expect(requests).toBe(1);
      expect(second).toEqual(first);
    });

    it("re-reads a shot once its ttl has passed", async () => {
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () => {
          requests += 1;
          return HttpResponse.json([mockShotData]);
        }),
      );

      let clock = 0;
      const client = createClient({
        baseUrl: "http://gaggiuino.local",
        now: () => clock,
      });

      await client.getShotData("1706547890");
      clock += SHOT_TTL_MS + 1;
      await client.getShotData("1706547890");

      expect(requests).toBe(2);
    });

    it("keeps shots apart by id", async () => {
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1", () =>
          HttpResponse.json([{ ...mockShotData, id: "1" }]),
        ),
        http.get("http://gaggiuino.local/api/shots/2", () =>
          HttpResponse.json([{ ...mockShotData, id: "2" }]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      expect((await client.getShotData("1")).id).toBe("1");
      expect((await client.getShotData("2")).id).toBe("2");
      expect((await client.getShotData("1")).id).toBe("1");
    });

    it("never caches machine status", async () => {
      // get_status promises an instantaneous reading, and "is it up to
      // temperature yet" is the question it is asked twice in a row.
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/system/status", () => {
          requests += 1;
          return HttpResponse.json([
            { ...mockMachineStatus, temperature: 90 + requests },
          ]);
        }),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      expect((await client.getStatus()).temperature).toBe(91);
      expect((await client.getStatus()).temperature).toBe(92);
    });

    it("does not cache a failed response", async () => {
      let requests = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/7", () => {
          requests += 1;
          if (requests === 1) {
            return HttpResponse.json({ error: "gone" }, { status: 404 });
          }
          return HttpResponse.json([{ ...mockShotData, id: "7" }]);
        }),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });

      await expect(client.getShotData("7")).rejects.toThrow(UpstreamHttpError);
      expect((await client.getShotData("7")).id).toBe("7");
    });

    it("does not let a cache hit claim the machine is reachable", async () => {
      // /health answers "is the machine up right now". Remembering a shot it
      // sent ten minutes ago is not evidence that it is.
      mockServer.use(
        http.get("http://gaggiuino.local/api/shots/1706547890", () =>
          HttpResponse.json([mockShotData]),
        ),
      );

      const client = createClient({ baseUrl: "http://gaggiuino.local" });
      await client.getShotData("1706547890");

      // resetClient() only clears the module-level observed health here; the
      // client under test is a local instance and keeps its cache.
      resetClient();
      await client.getShotData("1706547890");

      expect(getUpstreamHealth().state).toBe("unknown");
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
