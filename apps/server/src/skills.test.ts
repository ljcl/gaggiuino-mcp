import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderDialInGuidance } from "./guidance";
import { connectTestClient } from "./mcpTestClient";
import {
  buildDialInSkillFiles,
  DIAL_IN_SKILL_NAME,
  DIAL_IN_SKILL_URI,
  dialInSkill,
  referenceFileName,
  SKILL_FILE_MIME_TYPE,
  splitSections,
} from "./skills";
import { TOOLS_BY_NAME } from "./tools";

/** The real bundled guidance; the bundled YAML always carries the prompt. */
function rendered(): string {
  const text = renderDialInGuidance();
  if (text === undefined) throw new Error("bundled guidance is missing");
  return text;
}

function frontmatterOf(skillMd: string): Record<string, unknown> {
  const match = skillMd.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match?.[1]) throw new Error("SKILL.md has no frontmatter");
  return parse(match[1]) as Record<string, unknown>;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

describe("splitSections", () => {
  it("gives back the input exactly when its sections are joined", () => {
    // This is what lets the skill be checked for loss below: a split that
    // dropped the newline before a heading would pass every other test here.
    const text = rendered();
    expect(
      splitSections(text)
        .map((section) => section.text)
        .join(""),
    ).toBe(text);
  });

  it("keeps the text before the first heading as a headingless section", () => {
    expect(splitSections("intro\n\n## A\nbody\n")).toEqual([
      { heading: undefined, text: "intro\n\n" },
      { heading: "A", text: "## A\nbody\n" },
    ]);
  });

  it("makes no empty first section when the text starts with a heading", () => {
    expect(splitSections("## A\none\n## B\ntwo")).toEqual([
      { heading: "A", text: "## A\none\n" },
      { heading: "B", text: "## B\ntwo" },
    ]);
  });

  it("does not split on a deeper heading", () => {
    expect(splitSections("## A\n### A.1\nbody")).toHaveLength(1);
  });
});

describe("referenceFileName", () => {
  it("slugs a heading, punctuation and quotes included", () => {
    expect(referenceFileName('The "Natural Optimal Curve" Reference')).toBe(
      "the-natural-optimal-curve-reference.md",
    );
    expect(referenceFileName("Paper Filters (Optional)")).toBe(
      "paper-filters-optional.md",
    );
  });
});

describe("the dial-in skill's files", () => {
  const text = rendered();
  const files = buildDialInSkillFiles(text);
  const skillMd = files["SKILL.md"] ?? "";

  it("puts every section of the guidance in exactly one file", () => {
    // The one-renderer rule, stated as loss: a section the tool returns and
    // the skill does not is one a host that loads the skill never sees.
    const bodies = Object.values(files);
    for (const section of splitSections(text)) {
      const body = section.text.trim();
      if (body === "") continue;
      const holders = bodies.filter((file) => file.includes(body));
      expect(holders, section.heading ?? "(preamble)").toHaveLength(1);
    }
  });

  it("moves the reference sections out of SKILL.md and links each one", () => {
    const references = Object.keys(files).filter((path) =>
      path.startsWith("references/"),
    );
    expect(references).toContain("references/editing-a-profile.md");
    expect(references).toContain("references/available-profiles.md");
    for (const path of references) {
      expect(skillMd).toContain(`](${path}): `);
      expect(skillMd).not.toContain(files[path]?.trim());
    }
    // The core method stays where the host reads first.
    expect(skillMd).toContain("## Shot Phase Analysis");
    expect(skillMd).toContain("## Diagnostic Quick Reference");
  });

  it("carries frontmatter whose name is the skill path's last segment", () => {
    const frontmatter = frontmatterOf(skillMd);
    expect(frontmatter.name).toBe(DIAL_IN_SKILL_NAME);
    expect(DIAL_IN_SKILL_URI).toBe(`skill://${frontmatter.name}/SKILL.md`);
    // Agent Skills limits: a lowercase-hyphen name, a description under 1,024.
    expect(frontmatter.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
  });

  it("names only tools this server has, in the text this module writes", () => {
    // The guidance itself is user-editable and is checked nowhere for this,
    // the same exemption prompts.test.ts gives espresso_shot_analyst. The
    // frontmatter and the index are this module's own words.
    const own = skillMd.slice(skillMd.indexOf("## Reference files"));
    const description = String(frontmatterOf(skillMd).description);
    for (const source of [own, description]) {
      for (const [, name] of source.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) {
        expect(TOOLS_BY_NAME.has(name ?? ""), name).toBe(true);
      }
    }
  });

  it("stays inside Claude Code's limits: 100 KB a file, 400 KB a skill", () => {
    const sizes = Object.values(files).map((file) => Buffer.byteLength(file));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(400 * 1024);
  });

  it("keeps a section the table does not name in SKILL.md", () => {
    // A prompts.local.yaml override can add or rename sections; neither may
    // be dropped from the skill, and neither may become a reference file.
    const custom = buildDialInSkillFiles(
      "Intro\n\n## My Grinder Notes\nDF64\n\n## Editing a Profile\nedit\n",
    );
    expect(custom["SKILL.md"]).toContain("## My Grinder Notes\nDF64");
    expect(Object.keys(custom).sort()).toEqual([
      "SKILL.md",
      "references/editing-a-profile.md",
    ]);
  });

  it("writes no index when nothing moves to a reference file", () => {
    const custom = buildDialInSkillFiles("Intro\n\n## Only Section\nbody\n");
    expect(Object.keys(custom)).toEqual(["SKILL.md"]);
    expect(custom["SKILL.md"]).not.toContain("## Reference files");
  });
});

describe("dialInSkill", () => {
  it("serves one manifest entry for SKILL.md, covering every file", async () => {
    const skill = await dialInSkill();
    expect(skill?.entry.uri).toBe(DIAL_IN_SKILL_URI);
    const files = buildDialInSkillFiles(rendered());
    const manifest = skill?.entry.resources;
    if (!Array.isArray(manifest)) throw new Error("manifest is not a list");
    expect(manifest.map((resource) => resource.uri).sort()).toEqual(
      Object.keys(files)
        .map((path) => `skill://${DIAL_IN_SKILL_NAME}/${path}`)
        .sort(),
    );
  });

  it("builds once for the same rendering, so digests cannot drift between requests", async () => {
    // A digest that changed between two lists would make the host re-ask the
    // user to approve the skill on every visit.
    expect(await dialInSkill()).toBe(await dialInSkill());
  });

  it("rebuilds when the rendering changes", async () => {
    const first = await dialInSkill(() => "Intro\n\n## A\none\n");
    const second = await dialInSkill(() => "Intro\n\n## A\ntwo\n");
    expect(second).not.toBe(first);
    expect(second?.files.get(DIAL_IN_SKILL_URI)).toContain("two");
  });

  it("is undefined when no guidance is configured", async () => {
    expect(await dialInSkill(() => undefined)).toBeUndefined();
  });
});

describe("the skills extension over the wire", () => {
  it("lists the skill with the cache fields the extension requires", async () => {
    const client = await connectTestClient();
    const reply = await client.send("skills/list");
    const result = reply.result as Record<string, unknown>;
    expect(result.resultType).toBe("complete");
    expect(result.ttlMs).toBe(3_600_000);
    expect(result.cacheScope).toBe("private");
    expect(result.skills).toEqual([(await dialInSkill())?.entry]);
  });

  it("serves bytes that match the manifest's digest and size, file by file", async () => {
    // The host verifies each file it reads against the manifest and refuses a
    // mismatch, so this is the property that decides whether the skill loads.
    const client = await connectTestClient();
    const list = await client.send("skills/list");
    const [skill] = (list.result as { skills: Array<Record<string, unknown>> })
      .skills;
    const resources = skill?.resources as Array<{
      digest: string;
      size: number;
      uri: string;
    }>;
    expect(resources.length).toBeGreaterThan(1);
    for (const resource of resources) {
      const read = await client.readResource({ uri: resource.uri });
      const [content] = read.contents;
      expect(content?.mimeType).toBe(SKILL_FILE_MIME_TYPE);
      const body = content?.text ?? "";
      expect(Buffer.byteLength(body), resource.uri).toBe(resource.size);
      expect(sha256(body), resource.uri).toBe(resource.digest);
    }
  });

  it("returns the same entry from skills/get", async () => {
    const client = await connectTestClient();
    const reply = await client.send("skills/get", { uri: DIAL_IN_SKILL_URI });
    const result = reply.result as Record<string, unknown>;
    expect(result.skill).toEqual((await dialInSkill())?.entry);
    expect(result.ttlMs).toBe(3_600_000);
    expect(result.cacheScope).toBe("private");
  });

  it("answers -32602 for a skill or a skill file it does not serve", async () => {
    const client = await connectTestClient();
    const get = await client.send("skills/get", {
      uri: "skill://other/SKILL.md",
    });
    expect(get.error?.code).toBe(-32602);
    const read = await client.send("resources/read", {
      uri: `skill://${DIAL_IN_SKILL_NAME}/references/missing.md`,
    });
    expect(read.error?.code).toBe(-32602);
  });

  it("lists no skill file in resources/list", async () => {
    // A skill file is not a resource to browse: the spec forbids a host from
    // fetching one ahead of need, and listing them would invite exactly that.
    const client = await connectTestClient();
    const { resources } = await client.listResources();
    expect(
      resources.some((resource) => resource.uri.startsWith("skill://")),
    ).toBe(false);
  });
});
