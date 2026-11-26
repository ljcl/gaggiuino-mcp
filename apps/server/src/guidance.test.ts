import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens when `prompts.yaml` does not carry the dial-in prompt.
 *
 * Every other test in this repo runs against the real bundled YAML, where the
 * prompt is always present — so the three surfaces that have to cope without it
 * are only reachable by replacing the loader. Each fails differently on purpose:
 * a tool returns an `isError` result, a prompt throws, ListPrompts falls back
 * to a built-in description rather than advertising nothing, and the skills
 * extension lists no skill rather than answering an error mid-discovery.
 */
const loadPrompts = vi.hoisted(() => vi.fn());

vi.mock("./loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader")>()),
  loadPrompts,
}));

const { MISSING_GUIDANCE_TEXT, renderDialInGuidance } = await import(
  "./guidance"
);
const { advertisedPrompts, tryRenderPrompt } = await import("./prompts");
const { TOOLS_BY_NAME } = await import("./tools");
const { connectTestClient } = await import("./mcpTestClient");
const { DIAL_IN_SKILL_URI } = await import("./skills");

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

  it("has the prompt's render throw, since that is a config bug, not a bad request", () => {
    // Arguments were valid, so this is not an `invalid` outcome: the render
    // function itself throws, and a genuine bug propagates rather than being
    // dressed up as a caller mistake.
    expect(() => tryRenderPrompt("espresso_shot_analyst", {})).toThrow(
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

  it("lists no skill, and answers -32602 for the skill and its files", async () => {
    // skills/list is part of discovery once the extension is declared, so an
    // empty list is the answer; an error there is the failed-discovery case
    // AGENTS.md "Answer every method the advertised capabilities imply" names.
    const client = await connectTestClient();
    const list = await client.send("skills/list");
    expect((list.result as { skills: unknown[] }).skills).toEqual([]);
    const get = await client.send("skills/get", { uri: DIAL_IN_SKILL_URI });
    expect(get.error?.code).toBe(-32602);
    const read = await client.send("resources/read", {
      uri: DIAL_IN_SKILL_URI,
    });
    expect(read.error?.code).toBe(-32602);
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

  it("keeps the user context in the skill's SKILL.md, the file a host reads first", async () => {
    loadPrompts.mockReturnValue({
      espresso_shot_analyst: {
        description: "…",
        template: "Equipment:\n{user_context}\n\n{profiles_text}",
        userContext: "- Grinder: DF64 with SSP MP burrs",
      },
    });
    const client = await connectTestClient();
    const read = await client.readResource({ uri: DIAL_IN_SKILL_URI });
    expect(read.contents[0]?.text).toContain(
      "- Grinder: DF64 with SSP MP burrs",
    );
    // The profile list is reference material and moves out.
    expect(read.contents[0]?.text).toContain(
      "references/available-profiles.md",
    );
  });
});
