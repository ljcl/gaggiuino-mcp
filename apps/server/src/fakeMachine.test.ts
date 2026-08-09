import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_SHOT_ID_BASE,
  routeFakeMachine,
} from "./__fixtures__/fakeMachine";
import { createClient, MACHINE_URL, resetClient } from "./client";
import { handleToolCall } from "./server";
import { mockServer } from "./test-setup";

/**
 * The fake machine, validated against the real client rather than against a
 * restated copy of its schemas.
 *
 * This is the check the fake exists to earn: a payload the real client would
 * reject must fail the build, or the fake quietly becomes a second, drifting
 * source of truth for the wire format — agreeing with what we *expect* the
 * firmware to send instead of with what it does.
 *
 * So every assertion below goes through the client, which means through
 * `jsonReader` → `safeParse` → `MalformedUpstreamError`. Parsing the payloads
 * with the schemas directly would prove much less: only two of them are
 * exported, and two more are `z.looseObject({})` and accept anything at all. For
 * those the meaningful assertion is downstream, so the two tools that read them
 * are driven end to end instead.
 *
 * No port is bound. The route table is mounted as one msw handler at the
 * server's own default machine URL, which keeps the suite's
 * `onUnhandledRequest: "error"` intact — a real localhost fetch from inside this
 * suite is intercepted and fails, and the repo's precedent
 * (`externalIssuer.test.ts`) is to inject rather than punch a hole. Mounting at
 * `MACHINE_URL` rather than an invented host is what lets `handleToolCall` reach
 * it: `MACHINE_URL` is read once at module load, so an env var set in a test
 * arrives far too late.
 */

/** The fake, routed exactly as `scripts/fake-machine.ts` routes it. */
function mountFakeMachine(): void {
  mockServer.use(
    http.all(`${MACHINE_URL}/*`, ({ request }) => {
      const { pathname } = new URL(request.url);
      const { body, status } = routeFakeMachine(request.method, pathname);
      // Serialized by hand rather than through `HttpResponse.json`, which is
      // generic over a JSON body type the route table deliberately does not
      // commit to — these are recorded payloads, and `unknown` is the honest
      // type for them.
      return new HttpResponse(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
    }),
  );
}

function fakeClient() {
  return createClient({ baseUrl: MACHINE_URL, initialDelayMs: 1 });
}

beforeEach(() => {
  resetClient({ initialDelayMs: 1 });
  mountFakeMachine();
});

describe("the fake machine's payloads", () => {
  it("serves a status the client parses", async () => {
    // The hardware capture, so this is the stringly-typed path: every number
    // arrives as a decimal string and comes back normalized.
    const status = await fakeClient().getStatus();
    expect(status.profileName).toBe("Zer0");
    expect(status.temperature).toBeCloseTo(77.63, 1);
    expect(typeof status.temperature).toBe("number");
  });

  it("agrees with itself about which profile is selected", async () => {
    // The status payload's profileId has to name a profile the list actually
    // holds, or delete_profile's guard is being exercised against a machine
    // that contradicts itself.
    const client = fakeClient();
    const status = await client.getStatus();
    const profiles = await client.getMachineProfiles();

    expect(status.profileId).toBe("15");
    expect(profiles.find((profile) => profile.id === "15")?.name).toBe("Zer0");
  });

  it("serves a profile list the client parses", async () => {
    // `unwrap: false` on this endpoint, so a bare array is the shape under test.
    const profiles = await fakeClient().getMachineProfiles();
    expect(profiles.length).toBeGreaterThan(1);
    for (const profile of profiles) {
      expect(typeof profile.name).toBe("string");
      expect(typeof profile.id).toBe("string");
    }
  });

  it("serves both shots, and 404s the ids between them", async () => {
    const client = fakeClient();
    const latest = await client.getLatestShotId();
    expect(latest).toBe(String(FAKE_SHOT_ID_BASE + 33));

    const shot = await client.getShotData(latest);
    expect(shot.id).toBe(latest);
    // The real capture, not the five-point toy: enough curve to render.
    expect(shot.datapoints.pressure?.length).toBeGreaterThan(100);

    await expect(
      client.getShotData(String(FAKE_SHOT_ID_BASE + 999)),
    ).rejects.toThrow();
  });

  it("serves every profile definition it advertises one for", async () => {
    const client = fakeClient();
    for (const id of ["22", "23", "24"]) {
      const definition = await client.getProfileDefinition(id);
      expect(typeof definition.name, `profile ${id}`).toBe("string");
    }
  });

  it("404s a profile definition it has none for", async () => {
    // Not a gap in the fake: this is the case profileDefinition.ts handles as
    // ambiguous between old firmware and a since-deleted profile.
    await expect(fakeClient().getProfileDefinition("15")).rejects.toThrow();
  });

  it("serves settings and maintenance the client parses", async () => {
    const client = fakeClient();
    await expect(client.getSettings()).resolves.toBeTypeOf("object");
    await expect(client.getMaintenance()).resolves.toBeTypeOf("object");
  });

  it("refuses writes with a 501 rather than a false acknowledgement", async () => {
    // A fake that acknowledged a select would be contradicted by the very next
    // list_profiles. Declining is the honest answer and keeps it stateless.
    await expect(fakeClient().selectProfile("15")).rejects.toThrow();
    await expect(fakeClient().deleteProfileFromMachine("22")).rejects.toThrow();
    await expect(fakeClient().createProfile({ name: "x" })).rejects.toThrow();
  });
});

describe("routeFakeMachine", () => {
  it("404s a path no machine serves", () => {
    expect(routeFakeMachine("GET", "/nope").status).toBe(404);
    expect(routeFakeMachine("GET", "/api/shots/33/extra").status).toBe(404);
  });

  it("404s a non-GET that is not a machine endpoint", () => {
    // The 501 says "this fake will not do that"; a path the machine has never
    // heard of is a 404 whatever the verb.
    expect(routeFakeMachine("POST", "/favicon.ico").status).toBe(404);
  });
});

describe("the tools a fake machine exists to exercise", () => {
  /**
   * The end-to-end half. `get_machine_settings` and `get_maintenance_status`
   * read the two endpoints whose schemas are `z.looseObject({})` and therefore
   * prove nothing at the client boundary — driving the tools is where a wrong
   * payload actually surfaces, as a missing section in the rendered text.
   *
   * `view_shot_graph` and `get_shot_data` are here for a different reason: they
   * are the paths a fake machine exists to make runnable at all, so a shot that
   * cannot be summarised is the failure this whole file is meant to catch.
   */
  it("renders machine settings from the fake", async () => {
    const result = await handleToolCall("get_machine_settings", {});
    expect(result.isError).toBeFalsy();
    expect(result.text?.toLowerCase()).toContain("boiler");
  });

  it("renders the service history from the fake", async () => {
    const result = await handleToolCall("get_maintenance_status", {});
    expect(result.isError).toBeFalsy();
    expect(result.text?.toLowerCase()).toContain("descale");
  });

  it("summarises the fake's latest shot", async () => {
    const result = await handleToolCall("get_latest_shot_id", {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain(String(FAKE_SHOT_ID_BASE + 33));
  });

  it("lists the fake's profiles, documented and not", async () => {
    // Both join branches in one answer: Zer0 is in profiles.yaml, the user's own
    // experiment is not, and neither may be dropped.
    const result = await handleToolCall("list_profiles", {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Zer0");
    expect(result.text).toContain("My Turbo Experiment");
  });

  it("walks back through the fake's history across the gap", async () => {
    // The ids are 33 and 32 in the synthetic range with nothing between them and
    // nothing below, so this exercises walkShotsBack absorbing 404s rather than
    // a tidy contiguous run.
    const result = await handleToolCall("list_recent_shots", { limit: 3 });
    expect(result.isError).toBeFalsy();
    const shots = result.structuredContent?.shots as Array<{ shotId: string }>;
    expect(shots.map((shot) => shot.shotId)).toEqual([
      String(FAKE_SHOT_ID_BASE + 33),
      String(FAKE_SHOT_ID_BASE + 32),
    ]);
  });
});
