import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigError } from "./config";
import {
  loadProfiles,
  loadPrompts,
  mergeProfileOverrides,
  mergePromptOverrides,
  type Profile,
  ProfilesSchema,
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

describe("bundled profiles.yaml", () => {
  // Parsed directly rather than through loadProfiles, so a contributor's own
  // profiles.local.yaml cannot make this pass or fail. User overrides are
  // deliberately not held to it at run time.
  const bundled = ProfilesSchema.parse(
    parse(
      readFileSync(new URL("./data/profiles.yaml", import.meta.url), "utf-8"),
    ),
  );

  it("writes every target_ratio as dose:yield, the order its schema states", () => {
    // ProfileOutput.targetRatio says "dose to yield". A model trusting that
    // reads "2.3:1" as 2.3 g of coffee to 1 g in the cup — about 8 g from a
    // 19 g dose, not 44 — and choose_profile compares ratios across profiles,
    // which is exactly where two orders would meet.
    for (const [id, profile] of Object.entries(bundled)) {
      expect(
        profile.target_ratio,
        `${id}.target_ratio is not dose:yield`,
      ).toMatch(/^1:\d+(\.\d+)?( to 1:\d+(\.\d+)?)?$/);
    }
  });

  it("uses the same order in the prose beside it", () => {
    // Any espresso ratio with more coffee in than drink out is the reverse
    // order, so "2:1" and "2.3:1" are what a regression looks like.
    for (const [id, profile] of Object.entries(bundled)) {
      expect(
        profile.description,
        `${id}.description has a yield:dose ratio`,
      ).not.toMatch(/(?<![\d.])[2-9](\.\d+)?:1(?![\d.])/);
    }
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

  it("refuses invalid YAML, naming the file", () => {
    // Swallowed, this silently dropped the user's equipment context from the
    // guidance with nothing logged.
    writeFileSync(join(dir, "broken.local.yaml"), "user_context: [unclosed\n");
    const read = () =>
      readLocalOverrides(pathToFileURL(join(dir, "broken.yaml")));
    expect(read).toThrow(ConfigError);
    expect(read).toThrow(join(dir, "broken.local.yaml"));
    expect(read).toThrow("not valid YAML");
  });

  it("refuses an override that exists but cannot be read", () => {
    // A directory stands in for a bind mount the runtime user cannot read:
    // anything but ENOENT is a file the user wrote and this server failed to
    // apply, which is not the same answer as "no override".
    mkdirSync(join(dir, "unreadable.local.yaml"));
    const read = () =>
      readLocalOverrides(pathToFileURL(join(dir, "unreadable.yaml")));
    expect(read).toThrow(ConfigError);
    expect(read).toThrow(
      `Could not read ${join(dir, "unreadable.local.yaml")}`,
    );
  });
});

/** Where the merges say the bad override came from; any label will do. */
const SOURCE = "/data/example.local.yaml";

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
    expect(mergeProfileOverrides(base, undefined, SOURCE)).toBe(base);
  });

  it("treats an empty or all-comment file as no overrides", () => {
    // What a copied example with every line commented out parses to.
    expect(mergeProfileOverrides(base, null, SOURCE)).toBe(base);
  });

  it("refuses a YAML file that is not a mapping, naming the file", () => {
    // Ignored before, which is the silent failure a user cannot debug.
    const merge = () => mergeProfileOverrides(base, "zer0", SOURCE);
    expect(merge).toThrow(ConfigError);
    expect(merge).toThrow(`${SOURCE} is not a valid override file`);
    expect(merge).toThrow("(top level)");
  });

  it("replaces a documented profile wholesale", () => {
    const merged = mergeProfileOverrides(base, { zer0: override }, SOURCE);
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
    const merged = mergeProfileOverrides(base, { mine: override }, SOURCE);
    expect(Object.keys(merged).sort()).toEqual(["mine", "zer0"]);
  });

  it("deletes a profile whose override is null", () => {
    expect(mergeProfileOverrides(base, { zer0: null }, SOURCE)).toEqual({});
  });

  it("does not mutate the base it was given", () => {
    mergeProfileOverrides(base, { zer0: null }, SOURCE);
    expect(base.zer0).toBeDefined();
  });

  it("rejects an override that is not a profile, naming the key", () => {
    // `roast_level: light` — a scalar where a list belongs — used to throw a
    // raw ZodError on every list_profiles call rather than once at startup.
    const merge = () =>
      mergeProfileOverrides(
        base,
        { zer0: { ...override, roast_level: "light" } },
        SOURCE,
      );
    expect(merge).toThrow(ConfigError);
    expect(merge).toThrow("zer0.roast_level");
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
    expect(mergePromptOverrides(base, undefined, SOURCE)).toBe(base);
  });

  it("refuses a YAML file that holds a bare scalar", () => {
    expect(() =>
      mergePromptOverrides(base, "espresso_shot_analyst", SOURCE),
    ).toThrow(ConfigError);
  });

  it("rejects a YAML file that is a list rather than a mapping", () => {
    expect(() =>
      mergePromptOverrides(base, ["espresso_shot_analyst"], SOURCE),
    ).toThrow(/expected record/);
  });

  it("names the key when user_context is written as a list", () => {
    // Drop the `|` from the example file and this is what YAML hands back.
    // It used to fail prompts/list with -32603 on every request.
    const merge = () =>
      mergePromptOverrides(
        base,
        { espresso_shot_analyst: { user_context: ["Niche Zero"] } },
        SOURCE,
      );
    expect(merge).toThrow(ConfigError);
    expect(merge).toThrow("espresso_shot_analyst.user_context");
  });

  it("keeps every field the override leaves out", () => {
    // The realistic case: a user tunes `user_context` and nothing else.
    const merged = mergePromptOverrides(
      base,
      { espresso_shot_analyst: { user_context: "My grinder is a Niche Zero" } },
      SOURCE,
    );
    expect(merged.espresso_shot_analyst).toEqual({
      description: "Bundled description",
      template: "Bundled template",
      userContext: "My grinder is a Niche Zero",
    });
  });

  it("replaces every field the override does supply", () => {
    const merged = mergePromptOverrides(
      base,
      {
        espresso_shot_analyst: {
          description: "Mine",
          template: "My template",
          user_context: "Mine too",
        },
      },
      SOURCE,
    );
    expect(merged.espresso_shot_analyst).toEqual({
      description: "Mine",
      template: "My template",
      userContext: "Mine too",
    });
  });

  it("starts an unbundled prompt id from empty strings", () => {
    const merged = mergePromptOverrides(
      base,
      { my_prompt: { template: "Only a template" } },
      SOURCE,
    );
    expect(merged.my_prompt).toEqual({
      description: "",
      template: "Only a template",
      userContext: undefined,
    });
  });

  it("does not mutate the base it was given", () => {
    mergePromptOverrides(
      base,
      { espresso_shot_analyst: { description: "x" } },
      SOURCE,
    );
    expect(base.espresso_shot_analyst?.description).toBe("Bundled description");
  });
});
