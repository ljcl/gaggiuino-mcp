import { describe, expect, it } from "vitest";
import { getAllProfilesText, getProfile, listProfileEntries } from "./profiles";

describe("getProfile", () => {
  it("returns profile by ID", () => {
    const profile = getProfile("zer0");
    expect(profile).toBeDefined();
    expect(profile?.name).toBe("Zer0");
  });

  it("returns undefined for unknown profile", () => {
    const profile = getProfile("nonexistent");
    expect(profile).toBeUndefined();
  });
});

describe("listProfileEntries", () => {
  it("carries the id each profile is keyed by", () => {
    const entries = listProfileEntries();
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["zer0", "adaptive"]),
    );
    expect(entries.find((entry) => entry.id === "zer0")?.name).toBe("Zer0");
  });
});

describe("getAllProfilesText", () => {
  it("returns formatted text of all profiles", () => {
    const text = getAllProfilesText();
    expect(text).toContain("Zer0");
    expect(text).toContain("Adaptive");
    expect(text).toContain("flow");
  });
});
