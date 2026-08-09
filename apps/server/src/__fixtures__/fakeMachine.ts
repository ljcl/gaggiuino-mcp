/**
 * A Gaggiuino, assembled from recorded payloads, with no hardware behind it.
 *
 * `scripts/fake-machine.ts` serves this over HTTP so the server can be pointed
 * at it with `GAGGIUINO_URL`. What lives here is everything worth type-checking
 * and testing — the payloads and the routing — while the script itself is only
 * a port and a listener. That split is deliberate: the script is at the repo
 * root, which `turbo prune --docker` never copies, so the executable cannot ship
 * in the published image; this module is under `src/`, so it is type-checked, in
 * the coverage set, and reachable from a test that drives the **real client**
 * over it.
 *
 * ## Recorded, not invented
 *
 * The whole value of a fake is that it serves what the firmware actually sends.
 * A hand-written one serves the types we *expect*, agrees with our schemas by
 * construction, and proves nothing. So every payload below is traceable, and the
 * provenance is stated per route because it is not uniform:
 *
 * - `/api/system/status` is the one **hardware capture** in the repo — decimal
 *   strings for every number, real booleans for the switches.
 * - `/api/settings`, `/api/profile/*` and `/api/maintenance` come from the
 *   **vendored reference**, byte-for-byte.
 * - The shots are **real captures** off the machine, reachable through
 *   `packages/shot-graph`'s `./fixtures` export — ~190 samples at the machine's
 *   own ~0.15 s cadence, in the ×10 wire format. That is what makes rendering
 *   `view_shot_graph` against this fake worth doing; `mockShotData`'s five
 *   points at ten-second spacing have no curve to draw.
 * - `/api/profiles/all` is the one route with **no recorded body anywhere** —
 *   the reference documents it in a single line with no example. Its *shape*
 *   comes from `MachineProfileSchema`, and its *ids* from the sparse,
 *   non-contiguous set observed on real hardware while verifying #105
 *   (1, 3, 4, 6, 8, 15, 17, 19, 21, 22, 23, 24, 25, 26). Said plainly here
 *   rather than left to look as recorded as the rest.
 *
 * ## What it deliberately will not do
 *
 * Writes are refused with a 501 rather than acknowledged. Faking a successful
 * `select_profile` means the next `list_profiles` contradicts it, and a fake
 * that lies is worse than one that declines — so the refusal is the honest
 * answer, and it keeps this stateless. The moment this file grows a mutable
 * profile list it has become a second server and should be reconsidered.
 */

import {
  londiniumShot32,
  londiniumShot33,
} from "@gaggiuino/shot-graph/fixtures";
import {
  mockMachineSettingsFromDocs,
  mockMachineStatusFromHardware,
  mockProfileDefinition,
  mockProfileDefinitionFull,
  mockSparseProfileDefinition,
} from "./api-responses";

/**
 * Shot ids are offset into a range the machine cannot mint.
 *
 * Gaggiuino numbers shots small and sequentially, so a fake shot sharing an id
 * with a real one is a fake shot that can be mistaken for the user's — in a
 * conversation, in a screenshot, in a bug report. Nine hundred million is
 * visibly not a shot count. The idea is upstream's (`DEMO_ID_BASE` in
 * mxkissnr/gaggiuino-local-profiler); the reason to copy it is that "visibly
 * synthetic" is a property of the *number*, not of a flag somewhere else.
 */
export const FAKE_SHOT_ID_BASE = 900_000_000;

const latestShotId = String(FAKE_SHOT_ID_BASE + 33);
const previousShotId = String(FAKE_SHOT_ID_BASE + 32);

/**
 * The two real captures, re-keyed into the synthetic range.
 *
 * Spread rather than mutated: these are the same objects `analysis.test.ts` and
 * the Storybook stories read, and a fake that renamed them in place would change
 * what those assert.
 */
const shots: Record<string, unknown> = {
  [latestShotId]: { ...londiniumShot33, id: latestShotId },
  [previousShotId]: { ...londiniumShot32, id: previousShotId },
};

/**
 * What the machine holds.
 *
 * Chosen so the documentation join in `profileCatalog.ts` is exercised in every
 * direction rather than one: documented profiles that are loaded, undocumented
 * profiles the user built, documented profiles that are *not* loaded (the seven
 * `profiles.yaml` entries missing from this list), and — at id 17 — a name whose
 * case differs from the YAML's `LMD 9-8 v1.5 (Milk)`, which is the real
 * divergence `CatalogEntry.machineName` exists for.
 *
 * Id 15 is Zer0 because the captured status payload says the machine has profile
 * 15 selected. They have to agree, or `delete_profile`'s selected-profile guard
 * is being tested against a machine that contradicts itself.
 */
const profiles = [
  { id: "1", name: "Londinium" },
  { id: "3", name: "Adaptive" },
  { id: "4", name: "Blooming Espresso" },
  { id: "6", name: "Extractamundo Dos!" },
  { id: "8", name: "Leva 6 v0.9" },
  { id: "15", name: "Zer0" },
  { id: "17", name: "LMD 9-8 v1.5 (milk)" },
  { id: "19", name: "Leva 9 v0.9" },
  { id: "21", name: "My Turbo Experiment" },
  { id: "22", name: "18g Double" },
  { id: "23", name: "Lever Sim" },
  { id: "24", name: "Bare" },
];

/**
 * Per-profile definitions, for the three ids whose names match a recorded
 * definition fixture. Every other id answers 404 — which is not a gap in the
 * fake but the case `profileDefinition.ts` has specific handling for, where a
 * 404 is ambiguous between firmware that predates the endpoint and a profile
 * deleted since the list was read.
 */
const definitions: Record<string, unknown> = {
  "22": mockProfileDefinition,
  "23": mockProfileDefinitionFull,
  "24": mockSparseProfileDefinition,
};

/**
 * `GET /api/maintenance`, exactly as `docs/upstream/rest-api.md` L471-478
 * documents it. Epoch seconds, and `0` would mean never recorded.
 */
const maintenance = {
  lastBackflushTimestamp: 1753000000,
  lastDescaleTimestamp: 1753900000,
  shotsSinceBackflush: 10,
  shotsSinceDescale: 42,
};

/** What the fake answers with: an HTTP status, and a body to serialize as JSON. */
export interface FakeResponse {
  body: unknown;
  status: number;
}

const NOT_FOUND: FakeResponse = {
  body: { error: "not found" },
  status: 404,
};

/**
 * Everything this fake refuses, and why, in the response body.
 *
 * A 501 is the honest status: the endpoint exists on a real machine and is not
 * implemented *here*. The tools that reach it surface the body through
 * `describeUpstreamError`, so the person running the fake reads the reason
 * rather than a bare status.
 */
const NOT_IMPLEMENTED: FakeResponse = {
  body: {
    error:
      "The fake Gaggiuino is read-only. It has no state to change, so acknowledging a write would make the next read contradict it.",
  },
  status: 501,
};

/** The single trailing path segment, or undefined when there is not exactly one. */
function segmentAfter(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/") ? rest : undefined;
}

/**
 * Route one request. Pure, so the test can drive every route without a port.
 *
 * Read-only verbs are matched exactly; anything else that looks like a machine
 * endpoint gets the 501. An unrecognised path 404s, which is what a real machine
 * does and what `walkShotsBack` is built to absorb.
 */
export function routeFakeMachine(
  method: string,
  pathname: string,
): FakeResponse {
  if (method !== "GET") {
    return pathname.startsWith("/api/") ? NOT_IMPLEMENTED : NOT_FOUND;
  }

  if (pathname === "/api/system/status") {
    return { body: mockMachineStatusFromHardware, status: 200 };
  }
  if (pathname === "/api/settings") {
    return { body: mockMachineSettingsFromDocs, status: 200 };
  }
  if (pathname === "/api/maintenance") {
    return { body: maintenance, status: 200 };
  }
  if (pathname === "/api/shots/latest") {
    return { body: { lastShotId: latestShotId }, status: 200 };
  }
  // `unwrap: false` on this one endpoint, so it must be a bare array rather
  // than the one-element wrapper every other route may use.
  if (pathname === "/api/profiles/all") {
    return { body: profiles, status: 200 };
  }

  const shotId = segmentAfter(pathname, "/api/shots/");
  if (shotId !== undefined) {
    const shot = shots[shotId];
    return shot === undefined ? NOT_FOUND : { body: shot, status: 200 };
  }

  const profileId = segmentAfter(pathname, "/api/profile/");
  if (profileId !== undefined) {
    const definition = definitions[profileId];
    return definition === undefined
      ? NOT_FOUND
      : { body: definition, status: 200 };
  }

  return NOT_FOUND;
}

/** What the fake serves, for the banner the script prints on start. */
export const FAKE_MACHINE_SUMMARY = {
  latestShotId,
  previousShotId,
  profileCount: profiles.length,
  selectedProfileName: mockMachineStatusFromHardware.profileName,
};
