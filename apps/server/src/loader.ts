import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const ProfileSchema = z.object({
  name: z.string(),
  type: z.string(),
  roast_level: z.array(z.string()),
  target_ratio: z.string(),
  target_time: z.string(),
  recommended_dose: z.string().optional(),
  basket_notes: z.string().optional(),
  description: z.string(),
});

export const ProfilesSchema = z.record(z.string(), ProfileSchema);

export interface Profile {
  name: string;
  type: string;
  roastLevel: string[];
  targetRatio: string;
  targetTime: string;
  recommendedDose?: string;
  basketNotes?: string;
  description: string;
}

export const PromptSchema = z.object({
  description: z.string(),
  template: z.string(),
  user_context: z.string().optional(),
});

export const PromptsSchema = z.record(z.string(), PromptSchema);

export interface Prompt {
  description: string;
  template: string;
  userContext?: string;
}

function tryLoadLocalYaml(baseFilePath: URL): unknown | undefined {
  const localPath = new URL(
    baseFilePath.pathname.replace(/\.yaml$/, ".local.yaml"),
    baseFilePath,
  );
  try {
    return parse(readFileSync(localPath, "utf-8"));
  } catch {
    return undefined;
  }
}

function transformProfile(profile: z.output<typeof ProfileSchema>): Profile {
  return {
    name: profile.name,
    type: profile.type,
    roastLevel: profile.roast_level,
    targetRatio: profile.target_ratio,
    targetTime: profile.target_time,
    recommendedDose: profile.recommended_dose,
    basketNotes: profile.basket_notes,
    description: profile.description,
  };
}

let cachedProfiles: Record<string, Profile> | undefined;

export function loadProfiles(): Record<string, Profile> {
  if (cachedProfiles) {
    return cachedProfiles;
  }

  const filePath = new URL("./data/profiles.yaml", import.meta.url);
  const content = readFileSync(filePath, "utf-8");
  const raw = parse(content);

  const validated = ProfilesSchema.parse(raw);

  // Transform snake_case to camelCase
  const profiles: Record<string, Profile> = Object.fromEntries(
    Object.entries(validated).map(([id, profile]) => [
      id,
      transformProfile(profile),
    ]),
  );

  // Merge local overrides if present
  const localRaw = tryLoadLocalYaml(filePath);
  if (localRaw && typeof localRaw === "object" && localRaw !== null) {
    const LocalProfilesSchema = z.record(z.string(), ProfileSchema.nullable());
    const localValidated = LocalProfilesSchema.parse(localRaw);
    for (const [id, profile] of Object.entries(localValidated)) {
      if (profile === null) {
        delete profiles[id];
      } else {
        profiles[id] = transformProfile(profile);
      }
    }
  }

  cachedProfiles = profiles;
  return cachedProfiles;
}

let cachedPrompts: Record<string, Prompt> | undefined;

export function loadPrompts(): Record<string, Prompt> {
  if (cachedPrompts) {
    return cachedPrompts;
  }

  const filePath = new URL("./data/prompts.yaml", import.meta.url);
  const content = readFileSync(filePath, "utf-8");
  const raw = parse(content);

  const validated = PromptsSchema.parse(raw);

  const prompts: Record<string, Prompt> = Object.fromEntries(
    Object.entries(validated).map(([id, prompt]) => [
      id,
      {
        description: prompt.description,
        template: prompt.template,
        userContext: prompt.user_context,
      },
    ]),
  );

  // Merge local overrides if present
  const localRaw = tryLoadLocalYaml(filePath);
  if (localRaw && typeof localRaw === "object" && localRaw !== null) {
    const LocalPromptsSchema = z.record(z.string(), PromptSchema.partial());
    const localValidated = LocalPromptsSchema.parse(localRaw);
    for (const [id, overrides] of Object.entries(localValidated)) {
      const existing = prompts[id] ?? { description: "", template: "" };
      prompts[id] = {
        description: overrides.description ?? existing.description,
        template: overrides.template ?? existing.template,
        userContext: overrides.user_context ?? existing.userContext,
      };
    }
  }

  cachedPrompts = prompts;
  return cachedPrompts;
}
