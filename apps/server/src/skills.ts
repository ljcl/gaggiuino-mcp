import {
  type Skill,
  skillEntry,
} from "@modelcontextprotocol/server/ext/skills";
import { stringify } from "yaml";
import { renderDialInGuidance } from "./guidance";

/**
 * The dial-in guidance, published as an MCP skill (`io.modelcontextprotocol/skills`).
 *
 * `get_dial_in_guidance` returns the whole rendered template on every call —
 * ~29 KB, most of it reference material a given conversation never needs. A
 * skill is loaded by the host only when the task calls for it, and its
 * supporting files are read one at a time, so the same text can arrive in
 * pieces. The tool and the `espresso_shot_analyst` prompt stay: skills are
 * beta, absent from several surfaces, and removing the tool would drop a grant
 * existing installations hold.
 *
 * **Every byte comes from `renderDialInGuidance()`**, the one renderer the tool
 * and the prompt already share. The rendered text is cut at its `## ` headings;
 * the sections named in `REFERENCE_SECTIONS` become files under `references/`,
 * verbatim, and everything else stays in `SKILL.md` in its original order. A
 * section a `prompts.local.yaml` override adds or renames is therefore kept in
 * `SKILL.md` rather than dropped, and a placeholder added to the template is
 * substituted here exactly as it is on the other two surfaces.
 *
 * **The bytes are fixed per deployment.** The host checks each file against the
 * manifest digest, and a changed manifest revokes the user's approval of the
 * skill. The template and its override load once at startup, so the digest
 * moves only when a release or an override edit changes the guidance text —
 * which is then a real re-approval, the skill counterpart of a tool-grant change.
 */

/** The skill's name: the frontmatter `name` and the last segment of its path. */
export const DIAL_IN_SKILL_NAME = "espresso-dial-in";

/** Where the skill's `SKILL.md` is served. */
export const DIAL_IN_SKILL_URI = `skill://${DIAL_IN_SKILL_NAME}/SKILL.md`;

/** The MIME type every file of the skill is served with. */
export const SKILL_FILE_MIME_TYPE = "text/markdown";

const DESCRIPTION =
  "How to dial in espresso on this Gaggiuino machine: read a shot's pressure, flow and weight against its profile, choose a brew profile, change one variable at a time (grind, dose, ratio, temperature), and edit a profile safely before upload_profile. Use it before giving dial-in, shot-diagnosis or profile advice. It carries the user's own equipment notes.";

/**
 * The top-level sections moved out of `SKILL.md`, keyed by heading text, with
 * the line `SKILL.md` uses to say when to read each one. Keyed by heading
 * because that is the only handle the template gives a section; a heading this
 * table does not name stays in `SKILL.md`.
 */
const REFERENCE_SECTIONS: Readonly<Record<string, string>> = {
  "Available Profiles":
    "the bundled documentation for each brew profile. It is not the machine's inventory: call list_profiles for what is loaded.",
  "Editing a Profile":
    "read before changing any field of a profile for upload_profile. It says which field moves which symptom, and the unit traps.",
  "Flow Rate Targets by Ratio":
    "flow targets for a given brew ratio, when judging whether a shot ran fast or slow.",
  "Machine Capabilities":
    "what this machine can and cannot control, before suggesting a change it cannot make.",
  "Paper Filters (Optional)":
    "when the user uses or asks about a paper filter.",
  'The "Natural Optimal Curve" Reference':
    "the reference pressure and flow curve, when comparing a shot's shape to it.",
  "When Not to Trust the Data":
    "when a reading looks implausible, before drawing a conclusion from it.",
  "When the Water Is Not Arriving":
    "when a shot shows little or no flow, or pressure without yield.",
};

interface Section {
  /** The heading text without `## `; `undefined` for the text before the first heading. */
  heading: string | undefined;
  /** The section verbatim, heading line included, up to the next `## ` line. */
  text: string;
}

/**
 * Cut rendered guidance at each line that starts with `## `. Joining every
 * section's `text` gives back the input exactly, which is what lets a test
 * assert that the skill loses nothing.
 */
export function splitSections(rendered: string): Section[] {
  const sections: Section[] = [];
  let heading: string | undefined;
  let start = 0;
  const pattern = /^## (.+)$/gm;
  for (const match of rendered.matchAll(pattern)) {
    if (match.index > start || heading !== undefined) {
      sections.push({ heading, text: rendered.slice(start, match.index) });
    }
    heading = match[1]?.trim();
    start = match.index;
  }
  sections.push({ heading, text: rendered.slice(start) });
  return sections;
}

/** `Editing a Profile` → `editing-a-profile.md`. */
export function referenceFileName(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.md`;
}

/**
 * The skill's files, keyed by path under the skill folder (`SKILL.md`,
 * `references/<slug>.md`), from one rendering of the guidance.
 */
export function buildDialInSkillFiles(
  rendered: string,
): Record<string, string> {
  const kept: string[] = [];
  const references: Array<{ file: string; heading: string; hint: string }> = [];
  const files: Record<string, string> = {};

  for (const section of splitSections(rendered)) {
    const hint =
      section.heading === undefined
        ? undefined
        : REFERENCE_SECTIONS[section.heading];
    if (section.heading === undefined || hint === undefined) {
      kept.push(section.text);
      continue;
    }
    const file = `references/${referenceFileName(section.heading)}`;
    files[file] = section.text;
    references.push({ file, heading: section.heading, hint });
  }

  const frontmatter = `---\n${stringify({ name: DIAL_IN_SKILL_NAME, description: DESCRIPTION }, { lineWidth: 0 })}---\n\n`;
  const index =
    references.length === 0
      ? ""
      : [
          "",
          "## Reference files",
          "",
          "Read a file only when the task needs it. Paths are relative to this file.",
          "",
          ...references.map(
            ({ file, heading, hint }) => `- [${heading}](${file}): ${hint}`,
          ),
          "",
        ].join("\n");

  files["SKILL.md"] = `${frontmatter}${kept.join("").trimEnd()}\n${index}`;
  return files;
}

/** The skill as served: its manifest entry, and each file's text by URI. */
export interface ServedSkill {
  entry: Skill;
  files: ReadonlyMap<string, string>;
}

let served: { rendered: string; skill: Promise<ServedSkill> } | undefined;

/**
 * The dial-in skill, built once per rendering of the guidance; `undefined`
 * when the guidance is not configured, so `skills/list` answers an empty list
 * rather than an error.
 *
 * Memoised on the rendered text, not on first call: the loader caches the
 * template for the process, so in production this builds once, and a test that
 * swaps the loaded prompts still gets a skill that matches them.
 * `skillEntry` validates the frontmatter and the name-equals-path rule and
 * throws on a violation — a broken skill is a bug in this module, and the
 * SDK's error shaping is where a bug belongs.
 *
 * `render` is a test seam, the way `resetClient` is one in `client.ts`: every
 * production caller takes the default.
 */
export function dialInSkill(
  render: () => string | undefined = renderDialInGuidance,
): Promise<ServedSkill | undefined> {
  const rendered = render();
  if (rendered === undefined) return Promise.resolve(undefined);
  if (served?.rendered !== rendered) {
    const files = buildDialInSkillFiles(rendered);
    served = {
      rendered,
      skill: skillEntry(DIAL_IN_SKILL_NAME, files).then((entry) => ({
        entry,
        files: new Map(
          Object.entries(files).map(([path, text]) => [
            `skill://${DIAL_IN_SKILL_NAME}/${path}`,
            text,
          ]),
        ),
      })),
    };
  }
  return served.skill;
}
