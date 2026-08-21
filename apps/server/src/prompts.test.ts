import { describe, expect, it } from "vitest";
import {
  DIAL_IN_PROMPT_NAME,
  MISSING_GUIDANCE_TEXT,
  renderDialInGuidance,
} from "./guidance";
import {
  advertisedPrompts,
  PROMPT_DEFINITIONS,
  tryRenderPrompt,
} from "./prompts";

/**
 * The old throwing surface, rebuilt locally: the production wrapper died with
 * the split-era handlers (one dual-era `prompts/get` consumes the outcome
 * value directly), and these tests read better against a throw.
 */
function renderPrompt(name: string, args?: Record<string, string>): string {
  const outcome = tryRenderPrompt(name, args);
  if ("invalid" in outcome) throw new Error(outcome.invalid);
  return outcome.text;
}

/**
 * The protocol-level behaviour of these prompts is asserted in `server.test.ts`,
 * over a real client. What is left here is the registry itself: that every
 * definition is advertised consistently, and that a rendered plan only ever
 * names tools this server actually has.
 */
describe("advertisedPrompts", () => {
  it("advertises one entry per definition", () => {
    expect(advertisedPrompts().map((prompt) => prompt.name)).toEqual(
      PROMPT_DEFINITIONS.map((prompt) => prompt.name),
    );
  });

  it("gives every argument a description", () => {
    for (const prompt of advertisedPrompts()) {
      for (const arg of prompt.arguments ?? []) {
        expect(arg.description, `${prompt.name}.${arg.name}`).toBeTruthy();
      }
    }
  });

  it("advertises arguments as strings only", () => {
    // The protocol carries prompt arguments as strings and nothing else, so a
    // schema here that accepted a number would advertise a shape a host cannot
    // send.
    for (const prompt of PROMPT_DEFINITIONS) {
      const shape = prompt.argsSchema.shape;
      for (const [name, schema] of Object.entries(shape)) {
        expect(schema.safeParse(42).success, `${prompt.name}.${name}`).toBe(
          false,
        );
      }
    }
  });
});

describe("renderPrompt", () => {
  const requiredArgs: Record<string, Record<string, string>> = {
    choose_profile: { roast_level: "light" },
    dial_in_new_bag: { bean: "some coffee" },
    diagnose_last_shot: { taste: "sour" },
    espresso_shot_analyst: {},
  };

  it("covers every advertised prompt in this file's fixtures", () => {
    // Otherwise a new prompt silently skips every assertion below.
    expect(Object.keys(requiredArgs).sort()).toEqual(
      PROMPT_DEFINITIONS.map((prompt) => prompt.name).sort(),
    );
  });

  it("renders each prompt from its required arguments alone", () => {
    for (const [name, args] of Object.entries(requiredArgs)) {
      const text = renderPrompt(name, args);
      expect(text.length, name).toBeGreaterThan(0);
      // An unsubstituted placeholder is the failure this can't otherwise see:
      // the text still reads as prose, it just tells the model to fill a blank.
      expect(text, name).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it("names only tools this server advertises", async () => {
    // The plans are the one place a tool name is written as prose rather than
    // dispatched, so a renamed tool would leave a step pointing at nothing.
    //
    // Only the workflow prompts are checked. `espresso_shot_analyst` renders a
    // template from prompts.yaml that a user may replace wholesale, and backtick
    // spans in prose are not all tool names — holding user-editable text to this
    // rule would fail on a legitimate local override.
    const { TOOLS_BY_NAME } = await import("./tools");
    const workflows = PROMPT_DEFINITIONS.map((prompt) => prompt.name).filter(
      (name) => name !== DIAL_IN_PROMPT_NAME,
    );
    for (const name of workflows) {
      const mentioned = renderPrompt(name, requiredArgs[name] ?? {}).matchAll(
        /`([a-z_]+)`/g,
      );
      for (const [, mentionedName] of mentioned) {
        expect(
          TOOLS_BY_NAME.has(mentionedName ?? ""),
          `${name}: ${mentionedName}`,
        ).toBe(true);
      }
    }
  });

  it("throws naming the field when a required argument is absent", () => {
    expect(() => renderPrompt("choose_profile", {})).toThrow(
      /roast_level: missing/,
    );
  });

  it("throws on an unknown prompt", () => {
    expect(() => renderPrompt("nope", {})).toThrow("Unknown prompt: nope");
  });

  it("treats an absent arguments object as an empty one", () => {
    // `prompts/get` may omit `arguments` entirely; for a prompt that needs none
    // that is a valid request, not a malformed one.
    expect(renderPrompt("espresso_shot_analyst", undefined)).toBe(
      renderDialInGuidance(),
    );
  });
});

describe("renderDialInGuidance", () => {
  it("leaves no placeholder unsubstituted", () => {
    const guidance = renderDialInGuidance();
    expect(guidance).toBeDefined();
    expect(guidance).toContain("Available Profiles");
    expect(guidance).not.toContain("{user_context}");
    expect(guidance).not.toContain("{profiles_text}");
  });

  it("names the prompt a reader has to add to prompts.yaml", () => {
    expect(MISSING_GUIDANCE_TEXT).toContain("espresso_shot_analyst");
    expect(MISSING_GUIDANCE_TEXT).toContain("prompts.yaml");
  });
});
