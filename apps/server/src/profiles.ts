import { loadProfiles, type Profile } from "./loader";

export function getProfile(profileId: string): Profile | undefined {
  const profiles = loadProfiles();
  return profiles[profileId];
}

export function listProfileNames(): string[] {
  const profiles = loadProfiles();
  return Object.keys(profiles);
}

/** Every profile, each carrying the id it is keyed by. */
export function listProfileEntries(): Array<Profile & { id: string }> {
  return Object.entries(loadProfiles()).map(([id, profile]) => ({
    id,
    ...profile,
  }));
}

export function getAllProfilesText(): string {
  const profiles = loadProfiles();
  const lines: string[] = ["## Available Profiles\n"];

  for (const [id, profile] of Object.entries(profiles)) {
    lines.push(`### ${profile.name} (\`${id}\`)`);
    lines.push(`- Type: ${profile.type}`);
    lines.push(`- Best for: ${profile.roastLevel.join(", ")} roasts`);
    lines.push(`- Target ratio: ${profile.targetRatio}`);
    lines.push(`- Target time: ${profile.targetTime}`);
    lines.push("");
  }

  return lines.join("\n");
}
