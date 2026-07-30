import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { mockShotData } from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import { UpstreamUnreachableError } from "./errors";
import { MAX_GAP_PROBES, walkShotsBack } from "./history";
import { mockServer } from "./test-setup";

/** A machine holding exactly these ids, 404 for everything else. */
function machineWith(ids: number[], latest?: string) {
  const present = new Set(ids.map(String));
  const requested: string[] = [];
  mockServer.use(
    http.get("http://gaggiuino.local/api/shots/latest", () =>
      HttpResponse.json([
        { lastShotId: latest ?? String(Math.max(...ids, 0)) },
      ]),
    ),
    http.get("http://gaggiuino.local/api/shots/:id", ({ params }) => {
      const id = String(params.id);
      requested.push(id);
      if (!present.has(id)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      return HttpResponse.json([{ ...mockShotData, id }]);
    }),
  );
  return requested;
}

function idsOf(shots: Array<{ id: string }>): string[] {
  return shots.map((shot) => shot.id);
}

describe("walkShotsBack", () => {
  beforeEach(() => {
    resetClient({ initialDelayMs: 1 });
  });

  it("returns the newest shots first", async () => {
    machineWith([1, 2, 3, 4, 5]);
    expect(idsOf(await walkShotsBack({ limit: 3 }))).toEqual(["5", "4", "3"]);
  });

  it("steps over a deleted shot instead of stopping at it", async () => {
    // The defect this replaces: `id - 1` treated the hole at #4 as the
    // previous shot and fetched nothing.
    machineWith([1, 2, 3, 5], "5");
    expect(idsOf(await walkShotsBack({ limit: 3 }))).toEqual(["5", "3", "2"]);
  });

  it("stops at shot 1 rather than asking for shot 0", async () => {
    const requested = machineWith([1, 2]);
    const shots = await walkShotsBack({ limit: 5 });

    expect(idsOf(shots)).toEqual(["2", "1"]);
    expect(requested).not.toContain("0");
  });

  it("gives up once the gap budget is spent", async () => {
    // Walking off the end of retained history looks exactly like a long run
    // of 404s, and each one is a request to a microcontroller.
    const requested = machineWith([1, 20], "20");
    const shots = await walkShotsBack({ limit: 5 });

    expect(idsOf(shots)).toEqual(["20"]);
    expect(requested).toHaveLength(1 + MAX_GAP_PROBES);
  });

  it("never makes more requests than the limit plus the gap budget", async () => {
    const requested = machineWith(
      Array.from({ length: 40 }, (_, i) => i + 1),
      "40",
    );
    await walkShotsBack({ limit: 5 });

    expect(requested.length).toBeLessThanOrEqual(5 + MAX_GAP_PROBES);
  });

  it("walks back from a given id, exclusive", async () => {
    machineWith([1, 2, 3, 4, 5]);
    expect(idsOf(await walkShotsBack({ before: "4", limit: 2 }))).toEqual([
      "3",
      "2",
    ]);
  });

  it("returns nothing when asked for shots before the oldest one", async () => {
    machineWith([1, 2, 3]);
    expect(await walkShotsBack({ before: "1", limit: 3 })).toEqual([]);
  });

  it("returns nothing when asked to page back from a non-integer id", async () => {
    // Nothing sensible is below "a7f3", and NaN - 1 would walk from NaN.
    expect(await walkShotsBack({ before: "a7f3", limit: 3 })).toEqual([]);
  });

  it("returns nothing when the machine has no history", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/latest", () =>
        HttpResponse.json([{}]),
      ),
    );
    expect(await walkShotsBack({ limit: 5 })).toEqual([]);
  });

  it("falls back to the latest shot alone when ids are not integers", async () => {
    // A downward walk is only meaningful because this firmware mints ascending
    // integers. If that stops being true, one real shot beats NaN.
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/latest", () =>
        HttpResponse.json([{ lastShotId: "a7f3" }]),
      ),
      http.get("http://gaggiuino.local/api/shots/a7f3", () =>
        HttpResponse.json([{ ...mockShotData, id: "a7f3" }]),
      ),
    );

    expect(idsOf(await walkShotsBack({ limit: 5 }))).toEqual(["a7f3"]);
  });

  it("propagates an unreachable machine rather than returning a short list", async () => {
    // A partial list that quietly dropped the shots a broken machine could not
    // serve would be indistinguishable from a complete one.
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/latest", () =>
        HttpResponse.json([{ lastShotId: "5" }]),
      ),
      http.get("http://gaggiuino.local/api/shots/:id", () =>
        HttpResponse.error(),
      ),
    );

    await expect(walkShotsBack({ limit: 3 })).rejects.toThrow(
      UpstreamUnreachableError,
    );
  });
});
