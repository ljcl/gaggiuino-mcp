import { describe, expect, it } from "vitest";
import { getAllProfilesText, getProfile, listProfileNames } from "./profiles";

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

describe("listProfileNames", () => {
  it("returns array of profile IDs", () => {
    const names = listProfileNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain("zer0");
    expect(names).toContain("adaptive");
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
