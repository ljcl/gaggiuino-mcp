import { getClient, MACHINE_URL, type MachineProfile } from "./client";
import { describeUpstreamError } from "./errors";
import { listProfileEntries } from "./profiles";

/**
 * What profiles exist, and what this server knows about them.
 *
 * These are different questions: `data/profiles.yaml` is curated
 * *documentation* — what a profile is for, which roasts it suits, the ratio to
 * aim at — while the machine holds the inventory. Serving the documentation as
 * the inventory would hide profiles the user built and recommend ones they
 * deleted, so the machine is the authority on what exists and the YAML on what
 * it means, joined on the profile's name. Neither is complete alone:
 *
 * - **On the machine, documented** — the normal case, everything filled in.
 * - **On the machine, undocumented** — a profile the user made. Real, and
 *   selectable, with every documentation field null. This is the case the
 *   widened output schema exists for.
 * - **Documented, not on the machine** — still worth showing (it is what the
 *   dial-in guidance talks about), flagged so nothing recommends switching to
 *   a profile that is not there.
 *
 * When the machine cannot be reached the catalog degrades to the documentation
 * alone and says so, rather than failing a question the bundled data can very
 * nearly answer. `onMachine` is `null` in that case, not `false` — this server
 * did not check, and claiming it did would be the same class of lie the split
 * exists to fix.
 */
export interface CatalogEntry {
  basketNotes: string | null;
  description: string | null;
  /** Whether this server has curated documentation for the profile. */
  documented: boolean;
  /** Stable id for `get_profile_info`: the documented id, else the machine's. */
  id: string;
  /** The value `select_profile` needs, when the machine offered one. */
  machineProfileId: string | null;
  /**
   * The profile's name **as the machine spells it**, when it is on the machine.
   *
   * Not the same string as `name`. For a documented profile `name` is the
   * bundled YAML's spelling, because the join is on the lowercased, trimmed name
   * and `documentedEntry` keeps the YAML's copy — so the two legitimately differ
   * in case and spacing. This repo already contains an instance:
   * `profiles.yaml` says `LMD 9-8 v1.5 (Milk)` where the machine says `(milk)`.
   *
   * It exists because `delete_profile` makes the caller echo the profile's exact
   * name, and a confirmation gate has to check against what the user can
   * actually see. Deliberately absent from `ProfileOutput`, which is a
   * `z.object` and strips it before `structuredContent`, so no tool advertises
   * it and no permission grant moves.
   */
  machineName: string | null;
  name: string;
  onMachine: boolean | null;
  recommendedDose: string | null;
  roastLevels: string[];
  targetRatio: string | null;
  targetTime: string | null;
  type: string | null;
}

export interface ProfileCatalog {
  entries: CatalogEntry[];
  /** Why the entries look the way they do; carried into tool output verbatim. */
  note: string;
  source: "documentation" | "machine";
}

/** Profile names are user-typed; match them the way a person would read them. */
function matchKey(name: string): string {
  return name.trim().toLowerCase();
}

function documentedEntry(
  profile: ReturnType<typeof listProfileEntries>[number],
  onMachine: boolean | null,
  machineProfileId: string | null,
  machineName: string | null = null,
): CatalogEntry {
  return {
    basketNotes: profile.basketNotes ?? null,
    description: profile.description,
    documented: true,
    id: profile.id,
    machineName,
    machineProfileId,
    name: profile.name,
    onMachine,
    recommendedDose: profile.recommendedDose ?? null,
    roastLevels: profile.roastLevel,
    targetRatio: profile.targetRatio,
    targetTime: profile.targetTime,
    type: profile.type,
  };
}

function machineOnlyEntry(
  profile: MachineProfile,
  index: number,
): CatalogEntry {
  const machineProfileId = profile.id ?? null;
  return {
    basketNotes: null,
    description: null,
    documented: false,
    // A profile the user made has no curated id, so it is addressed by the
    // machine's own — and by its position when the firmware sends no id at all.
    id: machineProfileId ?? `profile-${index + 1}`,
    machineName: profile.name,
    machineProfileId,
    name: profile.name,
    onMachine: true,
    recommendedDose: null,
    roastLevels: [],
    targetRatio: null,
    targetTime: null,
    type: null,
  };
}

/** The documentation on its own, for when the machine cannot be asked. */
function documentationOnly(note: string): ProfileCatalog {
  return {
    entries: listProfileEntries().map((profile) =>
      documentedEntry(profile, null, null),
    ),
    note,
    source: "documentation",
  };
}

export async function loadProfileCatalog(): Promise<ProfileCatalog> {
  let machineProfiles: MachineProfile[];
  try {
    machineProfiles = await getClient().getMachineProfiles();
  } catch (error) {
    // Falling back is the right behaviour, but doing it silently would
    // present the bundled docs as the machine's inventory — the confusion
    // this module exists to prevent. The upstream diagnostic is already
    // written to be actionable, so it is reused rather than restated.
    const reason =
      describeUpstreamError(error, MACHINE_URL) ??
      "the request failed for a reason this server does not recognise";
    return documentationOnly(
      `The machine's own profile list could not be read, so these are this server's bundled documentation and may not match what is on the machine. ${reason}`,
    );
  }

  const documented = new Map(
    listProfileEntries().map((profile) => [matchKey(profile.name), profile]),
  );
  const seen = new Set<string>();

  const onMachine = machineProfiles.map((profile, index) => {
    const key = matchKey(profile.name);
    const docs = documented.get(key);
    if (!docs) return machineOnlyEntry(profile, index);
    seen.add(key);
    return documentedEntry(docs, true, profile.id ?? null, profile.name);
  });

  const absent = [...documented.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, profile]) => documentedEntry(profile, false, null));

  return {
    entries: [...onMachine, ...absent],
    note:
      absent.length === 0
        ? "Read from the machine, with this server's bundled documentation merged in by profile name."
        : `Read from the machine, with this server's bundled documentation merged in by profile name. ${absent.length} documented profile(s) are not currently on the machine and are listed last with onMachine false — do not recommend switching to one of those without asking the user to load it first.`,
    source: "machine",
  };
}

export async function findCatalogEntry(
  profileId: string,
): Promise<{ catalog: ProfileCatalog; entry: CatalogEntry | undefined }> {
  const catalog = await loadProfileCatalog();
  const wanted = matchKey(profileId);
  return {
    catalog,
    entry: catalog.entries.find(
      (candidate) =>
        matchKey(candidate.id) === wanted ||
        matchKey(candidate.name) === wanted ||
        (candidate.machineProfileId !== null &&
          matchKey(candidate.machineProfileId) === wanted),
    ),
  };
}
