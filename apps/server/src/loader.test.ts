import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadProfiles,
  loadPrompts,
  mergeProfileOverrides,
  mergePromptOverrides,
  type Profile,
  type Prompt,
  readLocalOverrides,
} from "./loader";

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

/**
 * The override machinery is tested through the pure functions and a temp
 * directory, never through `src/data/`. A test that wrote a real
 * `*.local.yaml` next to the bundled YAML would clobber a contributor's own
 * equipment configuration, and branches covered only when such a file happens
 * to exist make the coverage number depend on the machine measuring it.
 */
describe("readLocalOverrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "gaggiuino-loader-"));
  afterAll(() => rmSync(dir, { force: true, recursive: true }));

  it("parses the .local.yaml sitting beside the base file", () => {
    writeFileSync(join(dir, "present.local.yaml"), "zer0:\n  type: flow\n");
    expect(
      readLocalOverrides(pathToFileURL(join(dir, "present.yaml"))),
    ).toEqual({ zer0: { type: "flow" } });
  });

  it("returns undefined when the user has written no override", () => {
    expect(
      readLocalOverrides(pathToFileURL(join(dir, "absent.yaml"))),
    ).toBeUndefined();
  });
});

describe("mergeProfileOverrides", () => {
  const base: Record<string, Profile> = {
    zer0: {
      description: "Bundled",
      name: "Zer0",
      roastLevel: ["light"],
      targetRatio: "1:2",
      targetTime: "30s",
      type: "flow",
    },
  };

  const override = {
    description: "Mine",
    name: "Zer0",
    roast_level: ["dark"],
    target_ratio: "1:3",
    target_time: "25s",
    type: "pressure",
  };

  it("returns the base untouched when there are no overrides", () => {
    expect(mergeProfileOverrides(base, undefined)).toBe(base);
  });

  it("ignores a YAML file that is not a mapping", () => {
    expect(mergeProfileOverrides(base, "zer0")).toBe(base);
  });

  it("replaces a documented profile wholesale", () => {
    const merged = mergeProfileOverrides(base, { zer0: override });
    expect(merged.zer0).toEqual({
      basketNotes: undefined,
      description: "Mine",
      name: "Zer0",
      recommendedDose: undefined,
      roastLevel: ["dark"],
      targetRatio: "1:3",
      targetTime: "25s",
      type: "pressure",
    });
  });

  it("adds a profile the bundled documentation does not carry", () => {
    const merged = mergeProfileOverrides(base, { mine: override });
    expect(Object.keys(merged).sort()).toEqual(["mine", "zer0"]);
  });

  it("deletes a profile whose override is null", () => {
    expect(mergeProfileOverrides(base, { zer0: null })).toEqual({});
  });

  it("does not mutate the base it was given", () => {
    mergeProfileOverrides(base, { zer0: null });
    expect(base.zer0).toBeDefined();
  });

  it("rejects an override that is not a profile", () => {
    expect(() => mergeProfileOverrides(base, { zer0: { name: 1 } })).toThrow();
  });
});

describe("mergePromptOverrides", () => {
  const base: Record<string, Prompt> = {
    espresso_shot_analyst: {
      description: "Bundled description",
      template: "Bundled template",
      userContext: "Bundled context",
    },
  };

  it("returns the base untouched when there are no overrides", () => {
    expect(mergePromptOverrides(base, undefined)).toBe(base);
  });

  it("ignores a YAML file that holds a bare scalar", () => {
    expect(mergePromptOverrides(base, "espresso_shot_analyst")).toBe(base);
  });

  it("rejects a YAML file that is a list rather than a mapping", () => {
    expect(() => mergePromptOverrides(base, ["espresso_shot_analyst"])).toThrow(
      /expected record/,
    );
  });

  it("keeps every field the override leaves out", () => {
    // The realistic case: a user tunes `user_context` and nothing else.
    const merged = mergePromptOverrides(base, {
      espresso_shot_analyst: { user_context: "My grinder is a Niche Zero" },
    });
    expect(merged.espresso_shot_analyst).toEqual({
      description: "Bundled description",
      template: "Bundled template",
      userContext: "My grinder is a Niche Zero",
    });
  });

  it("replaces every field the override does supply", () => {
    const merged = mergePromptOverrides(base, {
      espresso_shot_analyst: {
        description: "Mine",
        template: "My template",
        user_context: "Mine too",
      },
    });
    expect(merged.espresso_shot_analyst).toEqual({
      description: "Mine",
      template: "My template",
      userContext: "Mine too",
    });
  });

  it("starts an unbundled prompt id from empty strings", () => {
    const merged = mergePromptOverrides(base, {
      my_prompt: { template: "Only a template" },
    });
    expect(merged.my_prompt).toEqual({
      description: "",
      template: "Only a template",
      userContext: undefined,
    });
  });

  it("does not mutate the base it was given", () => {
    mergePromptOverrides(base, { espresso_shot_analyst: { description: "x" } });
    expect(base.espresso_shot_analyst?.description).toBe("Bundled description");
  });
});
