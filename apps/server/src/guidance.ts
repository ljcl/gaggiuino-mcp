import { loadPrompts } from "./loader";
import { getAllProfilesText } from "./profiles";

/** The prompt in `data/prompts.yaml` that carries the dial-in guidance. */
export const DIAL_IN_PROMPT_NAME = "espresso_shot_analyst";

/**
 * The dial-in guidance, rendered from the loaded template.
 *
 * Two surfaces serve this same text — the `get_dial_in_guidance` tool, for a
 * model that needs it mid-conversation, and the `espresso_shot_analyst` prompt,
 * for a user who invokes it deliberately. This is the only place the template
 * is interpolated, so a placeholder added to the YAML is substituted
 * identically on both.
 *
 * Returns `undefined` when the prompt is missing from `prompts.yaml`, so each
 * caller can fail the way its own protocol expects — the tool returns an
 * `isError` result, the prompt throws.
 */
export function renderDialInGuidance(): string | undefined {
  const prompt = loadPrompts()[DIAL_IN_PROMPT_NAME];
  if (!prompt) return undefined;
  return prompt.template
    .replace("{user_context}", prompt.userContext ?? "")
    .replace("{profiles_text}", getAllProfilesText());
}

/** What a caller says when `renderDialInGuidance()` comes back empty. */
export const MISSING_GUIDANCE_TEXT = `Dial-in guidance is not configured on this server (prompt '${DIAL_IN_PROMPT_NAME}' is missing from prompts.yaml).`;
