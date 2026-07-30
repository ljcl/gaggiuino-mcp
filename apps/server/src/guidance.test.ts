import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens when `prompts.yaml` does not carry the dial-in prompt.
 *
 * Every other test in this repo runs against the real bundled YAML, where the
 * prompt is always present — so the three surfaces that have to cope without it
 * are only reachable by replacing the loader. Each fails differently on purpose:
 * a tool returns an `isError` result, a prompt throws, and ListPrompts falls back
 * to a built-in description rather than advertising nothing.
 */
const loadPrompts = vi.hoisted(() => vi.fn());

vi.mock("./loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader")>()),
  loadPrompts,
}));

const { MISSING_GUIDANCE_TEXT, renderDialInGuidance } = await import(
  "./guidance"
);
const { advertisedPrompts, renderPrompt } = await import("./prompts");
const { TOOLS_BY_NAME } = await import("./tools");

beforeEach(() => {
  loadPrompts.mockReset();
});

describe("with the dial-in prompt missing from prompts.yaml", () => {
  beforeEach(() => {
    loadPrompts.mockReturnValue({});
  });

  it("renders no guidance", () => {
    expect(renderDialInGuidance()).toBeUndefined();
  });

  it("has get_dial_in_guidance say which prompt to add and where", async () => {
    const tool = TOOLS_BY_NAME.get("get_dial_in_guidance");
    const reply = await tool?.handler({});
    expect(reply).toEqual({ isError: true, text: MISSING_GUIDANCE_TEXT });
  });

  it("has the prompt throw, since prompts have no isError channel", () => {
    expect(() => renderPrompt("espresso_shot_analyst", {})).toThrow(
      "Missing prompt: espresso_shot_analyst",
    );
  });

  it("still advertises the prompt with a description", () => {
    // A prompt advertised with no description is one a host lists as a bare
    // name, which is worse than a generic sentence.
    const advertised = advertisedPrompts().find(
      (prompt) => prompt.name === "espresso_shot_analyst",
    );
    expect(advertised?.description).toBeTruthy();
  });
});

describe("with a user's equipment context configured", () => {
  it("interpolates the user context into the guidance", () => {
    // The path a prompts.local.yaml override takes: user_context is optional in
    // the schema, so the bundled YAML leaves it unset and only an override fills
    // it in.
    loadPrompts.mockReturnValue({
      espresso_shot_analyst: {
        description: "…",
        template: "Equipment:\n{user_context}\n\n{profiles_text}",
        userContext: "- Grinder: DF64 with SSP MP burrs",
      },
    });
    const guidance = renderDialInGuidance();
    expect(guidance).toContain("- Grinder: DF64 with SSP MP burrs");
    expect(guidance).toContain("Available Profiles");
    expect(guidance).not.toContain("{user_context}");
  });
});
