import { describe, expect, it } from "vitest";
import { loadProfiles, loadPrompts } from "./loader";

describe("loadProfiles", () => {
  it("loads profiles from YAML", () => {
    const profiles = loadProfiles();
    expect(profiles).toBeDefined();
    expect(Object.keys(profiles).length).toBeGreaterThan(0);
  });

  it("includes zer0 profile", () => {
    const profiles = loadProfiles();
    const zer0 = profiles.zer0;
    expect(zer0).toBeDefined();
    expect(zer0?.name).toBe("Zer0");
    expect(zer0?.type).toBe("flow");
  });

  it("validates profile structure", () => {
    const profiles = loadProfiles();
    const profile = profiles.zer0;
    expect(profile).toBeDefined();

    expect(profile?.name).toBeTypeOf("string");
    expect(profile?.type).toBeTypeOf("string");
    expect(Array.isArray(profile?.roastLevel)).toBe(true);
    expect(profile?.targetRatio).toBeTypeOf("string");
    expect(profile?.targetTime).toBeTypeOf("string");
    expect(profile?.description).toBeTypeOf("string");
  });
});

describe("loadPrompts", () => {
  it("loads prompts from YAML", () => {
    const prompts = loadPrompts();
    expect(prompts).toBeDefined();
  });

  it("includes espresso_shot_analyst prompt", () => {
    const prompts = loadPrompts();
    const prompt = prompts.espresso_shot_analyst;
    expect(prompt).toBeDefined();
    expect(prompt?.description).toBeTypeOf("string");
    expect(prompt?.template).toBeTypeOf("string");
  });

  it("handles optional user_context field gracefully", () => {
    const prompts = loadPrompts();
    const prompt = prompts.espresso_shot_analyst;
    // user_context is optional - should be undefined or a string
    expect(
      prompt?.userContext === undefined ||
        typeof prompt?.userContext === "string",
    ).toBe(true);
  });

  it("template contains {user_context} placeholder", () => {
    const prompts = loadPrompts();
    expect(prompts.espresso_shot_analyst?.template).toContain("{user_context}");
  });
});
