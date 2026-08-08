import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_MACHINE_URL,
  DEFAULT_PORT,
  loadServerConfig,
} from "./config";
import { parseLogLevel } from "./logging";
import { loadSecurityConfig } from "./mcpAuth";

/**
 * `.env.example` is the file the deployment path tells users to copy, so a
 * variable missing from it is a variable most users never learn exists. PR #75
 * added four and updated README, AGENTS.md, SECURITY.md, `server.json`,
 * `turbo.json`, and `docker-compose.yml` — but not this one, and nothing
 * failed. It took a backlog sweep to notice (#77) and four days to fix.
 *
 * These assertions exist so the next omission is a build failure instead.
 */
const TEMPLATE = fileURLToPath(
  new URL("../../../.env.example", import.meta.url),
);

/**
 * Every environment variable the server reads, discovered by scanning the
 * source rather than listed here — a hand-maintained list is the same thing
 * that drifted in the first place, just moved.
 *
 * `env.NAME` catches both `process.env.NAME` and the injected
 * `Record<string, string | undefined>` that `loadServerConfig` and
 * `loadSecurityConfig` take, which is every shape this server uses.
 */
function variablesReadFromSource(): Map<string, string[]> {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const readers = new Map<string, string[]>();
  // Recursive, because the scan is the guard. A flat `readdirSync` covered
  // `src/*.ts` only, so the day a variable was first read from a subdirectory
  // — `src/oauth/` — this test would have gone on passing while the template
  // silently stopped documenting it. That is the exact failure it exists to
  // catch, one directory deeper.
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const label = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${label}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(join(dir, entry.name), "utf-8");
      for (const [, name] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
        if (name) readers.set(name, [...(readers.get(name) ?? []), label]);
      }
    }
  };
  walk(root, "");
  return readers;
}

const template = readFileSync(TEMPLATE, "utf-8");

/** Variable names the template mentions, whether commented out or set. */
function documentedVariables(): Set<string> {
  return new Set(
    [...template.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].flatMap(([, name]) =>
      name ? [name] : [],
    ),
  );
}

/** The template's *active* settings, as a dotenv loader would read them. */
function activeSettings(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of template.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? "";
  }
  return env;
}

describe(".env.example", () => {
  it("documents every variable the server reads", () => {
    const documented = documentedVariables();
    const missing = [...variablesReadFromSource()]
      .filter(([name]) => !documented.has(name))
      .map(
        ([name, files]) =>
          `${name} (read by ${[...new Set(files)].join(", ")})`,
      );
    expect(missing).toEqual([]);
  });

  it("documents nothing the server has stopped reading", () => {
    // The other drift direction: a variable removed from the code but left in
    // the template sends users to configure something that does nothing.
    const read = variablesReadFromSource();
    expect(
      [...documentedVariables()].filter((name) => !read.has(name)),
    ).toEqual([]);
  });

  it("leaves the OAuth variables commented out rather than set", () => {
    // Same reasoning as the token above, with a sharper edge: a placeholder
    // MCP_PUBLIC_URL would be advertised as this server's `resource` and every
    // token minted against it would be rejected on arrival.
    for (const name of ["MCP_PUBLIC_URL", "MCP_OAUTH_SECRET"]) {
      expect(template).toMatch(new RegExp(`^#${name}=`, "m"));
      expect(template).not.toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("ships a template that serves /mcp open with empty allowlists", () => {
    expect(loadSecurityConfig(activeSettings())).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      oauth: undefined,
      token: undefined,
    });
  });

  it("ships a template that parses to the documented server defaults", () => {
    // Not just valid — equal to the defaults the code itself declares, so the
    // template cannot quietly ship a different machine URL or port than the
    // one AGENTS.md advertises.
    expect(loadServerConfig(activeSettings())).toEqual({
      host: DEFAULT_HOST,
      machineUrl: DEFAULT_MACHINE_URL,
      port: DEFAULT_PORT,
    });
  });

  it("ships a template whose log level is the default", () => {
    expect(parseLogLevel(activeSettings().LOG_LEVEL)).toBe("info");
  });
});
