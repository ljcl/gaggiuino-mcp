import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * The handshake used to advertise a hardcoded "1.0.0" that no release ever
 * touched, so the advertised version drifted further from the released one with
 * every tag. These tests are the guard on the mechanism that replaced it: they
 * fail if the literal falls behind the release manifest, and — separately — if
 * the release-please annotation that keeps it current is ever dropped by a
 * refactor. Losing the annotation silently would reintroduce the original bug
 * one release later, which is exactly how it went unnoticed the first time.
 */

async function readJson(relativePath: string): Promise<{ version?: string }> {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(url, "utf-8"));
}

describe("SERVER_VERSION", () => {
  it("matches the version release-please tracks in root package.json", async () => {
    const rootPackage = await readJson("../../../package.json");
    expect(SERVER_VERSION).toBe(rootPackage.version);
  });

  it("matches the version published to the MCP registry in server.json", async () => {
    const serverManifest = await readJson("../../../server.json");
    expect(SERVER_VERSION).toBe(serverManifest.version);
  });

  it("keeps the release-please annotation on the literal that gets bumped", async () => {
    const source = await fs.readFile(
      new URL("./version.ts", import.meta.url),
      "utf-8",
    );
    // The annotation has to sit on the assignment line, not merely somewhere in
    // the file: release-please's generic updater rewrites the version on the
    // annotated line only. Matching on the export name rather than the first
    // occurrence keeps the prose above from satisfying this test.
    const assignment = source
      .split("\n")
      .find((line) => line.includes("export const SERVER_VERSION"));
    expect(
      assignment,
      "SERVER_VERSION is no longer a literal export",
    ).toContain("x-release-please-version");
    expect(assignment).toContain(`"${SERVER_VERSION}"`);
  });
});

describe("SERVER_NAME", () => {
  it("matches the MCP registry name proven by the image label", async () => {
    const serverManifest = (await readJson("../../../server.json")) as {
      name?: string;
    };
    // server.json is namespaced (`io.github.<owner>/<name>`); the handshake
    // advertises the bare name. The suffix is the part that has to agree.
    expect(serverManifest.name).toMatch(new RegExp(`/${SERVER_NAME}$`));
  });
});
