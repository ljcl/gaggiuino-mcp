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

/**
 * Read the `*.local.yaml` sitting beside a bundled data file, or `undefined`
 * when the user has not written one. Absence is the normal case, not an error.
 *
 * Exported so a test can point it at a temp directory, keeping coverage
 * independent of whatever override files happen to be on disk. See AGENTS.md
 * "Test coverage".
 */
export function readLocalOverrides(baseFilePath: URL): unknown {
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

/**
 * Apply a user's profile overrides over the bundled documentation. A `null`
 * value deletes a profile; anything else replaces it wholesale.
 *
 * Pure, and takes the overrides rather than reading them, so both the
 * has-overrides and no-overrides paths are exercised by tests instead of by
 * the filesystem.
 */
export function mergeProfileOverrides(
  base: Record<string, Profile>,
  overrides: unknown,
): Record<string, Profile> {
  if (!overrides || typeof overrides !== "object") {
    return base;
  }

  const LocalProfilesSchema = z.record(z.string(), ProfileSchema.nullable());
  const merged = { ...base };
  for (const [id, profile] of Object.entries(
    LocalProfilesSchema.parse(overrides),
  )) {
    if (profile === null) {
      delete merged[id];
    } else {
      merged[id] = transformProfile(profile);
    }
  }
  return merged;
}

/**
 * Apply a user's prompt overrides over the bundled ones. Overrides are partial:
 * an absent field keeps whatever the bundled prompt said, and an id the bundle
 * does not carry starts from empty strings.
 */
export function mergePromptOverrides(
  base: Record<string, Prompt>,
  overrides: unknown,
): Record<string, Prompt> {
  if (!overrides || typeof overrides !== "object") {
    return base;
  }

  const LocalPromptsSchema = z.record(z.string(), PromptSchema.partial());
  const merged = { ...base };
  for (const [id, override] of Object.entries(
    LocalPromptsSchema.parse(overrides),
  )) {
    const existing = merged[id] ?? { description: "", template: "" };
    merged[id] = {
      description: override.description ?? existing.description,
      template: override.template ?? existing.template,
      userContext: override.user_context ?? existing.userContext,
    };
  }
  return merged;
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

  const profiles: Record<string, Profile> = Object.fromEntries(
    Object.entries(validated).map(([id, profile]) => [
      id,
      transformProfile(profile),
    ]),
  );

  cachedProfiles = mergeProfileOverrides(
    profiles,
    readLocalOverrides(filePath),
  );
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

  cachedPrompts = mergePromptOverrides(prompts, readLocalOverrides(filePath));
  return cachedPrompts;
}
