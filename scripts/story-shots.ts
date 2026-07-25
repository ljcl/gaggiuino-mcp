/**
 * Screenshot Storybook stories to PNGs, for looking at UI work without a
 * browser in the loop — a `bun run storybook` tab is not reachable from a
 * Claude Code cloud session, and the Vitest story tests only assert DOM and
 * accessibility, never pixels.
 *
 * This is a *look at it* tool, not a gate. There is deliberately no baseline
 * comparison (see the "no pixel-level visual-regression gate" note in
 * AGENTS.md): its job is to put a rendered view in front of a human or an
 * agent so the judgement calls a DOM assertion cannot make — an axis that
 * misleads, a clipped label, a chart that says the wrong thing — get made.
 *
 *   bun run shots --list
 *   bun run shots shot-graph-shotgraph--single-shot
 *   bun run shots --width 380 shot-graph-shotgraph--mobile-single
 *   bun run shots --dark --hover "svg.recharts-surface" shot-graph-shotgraph--single-shot
 *
 * Renders against a static Storybook build by default (built on demand, then
 * reused); pass --url http://localhost:6006 to shoot a running dev server
 * instead, which skips the build and picks up edits live.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveChromiumExecutablePath } from "./playwright-chromium";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const staticDir = path.join(repoRoot, "apps/storybook/storybook-static");

interface Options {
  storyIds: string[];
  width: number;
  height: number;
  outDir: string;
  /** Existing Storybook origin to shoot against; omitted = static build. */
  url?: string;
  /** Extra Storybook globals, e.g. "hostTheme:claude". */
  globals: string[];
  /** CSS selector to hover before the shot (chart tooltips, hover states). */
  hover?: string;
  /** Where in the hovered element to point, as {x,y} fractions of its box. */
  hoverAt: { x: number; y: number };
  /** Settle time after load, for chart mount + ResponsiveContainer resize. */
  waitMs: number;
  list: boolean;
  rebuild: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    storyIds: [],
    width: 900,
    height: 800,
    outDir: path.join(repoRoot, "story-shots"),
    globals: [],
    hoverAt: { x: 0.5, y: 0.5 },
    waitMs: 1200,
    list: false,
    rebuild: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--list":
        options.list = true;
        break;
      case "--width":
        options.width = Number(next());
        break;
      case "--height":
        options.height = Number(next());
        break;
      case "--out":
        options.outDir = path.resolve(repoRoot, next());
        break;
      case "--url":
        options.url = next().replace(/\/$/, "");
        break;
      case "--dark":
        options.globals.push("backgrounds.value:dark");
        break;
      case "--globals":
        options.globals.push(next());
        break;
      case "--hover":
        options.hover = next();
        break;
      case "--hover-at": {
        const [x, y] = next().split(",").map(Number);
        options.hoverAt = { x: x ?? 0.5, y: y ?? 0.5 };
        break;
      }
      case "--wait":
        options.waitMs = Number(next());
        break;
      case "--rebuild":
        options.rebuild = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
        options.storyIds.push(arg);
    }
  }

  return options;
}

/** Build the static Storybook unless one is already there (or --rebuild). */
function ensureStaticBuild(rebuild: boolean): void {
  if (existsSync(path.join(staticDir, "index.html")) && !rebuild) {
    console.error(
      `Using existing build at ${path.relative(repoRoot, staticDir)} (--rebuild to refresh)`,
    );
    return;
  }
  console.error("Building Storybook…");
  const result = spawnSync("bun", ["run", "build-storybook"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new Error("Storybook build failed");
}

/** Serve the static build; Playwright cannot load Storybook over file://. */
function serveStatic(): { origin: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const file = Bun.file(
        path.join(staticDir, pathname === "/" ? "index.html" : pathname),
      );
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  });
  return {
    origin: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** Story ids and titles from the build's index, for --list. */
async function fetchStoryIds(origin: string): Promise<string[]> {
  const response = await fetch(`${origin}/index.json`);
  if (!response.ok) throw new Error(`No story index at ${origin}/index.json`);
  const index = (await response.json()) as {
    entries: Record<
      string,
      { id: string; title: string; name: string; type: string }
    >;
  };
  return Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .map((entry) => `${entry.id}\t${entry.title} › ${entry.name}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.list && options.storyIds.length === 0) {
    console.error(
      "Usage: bun run shots [--list] [--width N] [--height N] [--dark] [--hover SELECTOR] [--url ORIGIN] <story-id>…",
    );
    process.exitCode = 1;
    return;
  }

  let origin = options.url;
  let stopServer: (() => void) | undefined;
  if (!origin) {
    ensureStaticBuild(options.rebuild);
    const server = serveStatic();
    origin = server.origin;
    stopServer = server.stop;
  }

  try {
    if (options.list) {
      for (const line of await fetchStoryIds(origin)) console.log(line);
      return;
    }

    mkdirSync(options.outDir, { recursive: true });
    const browser = await chromium.launch({
      executablePath: resolveChromiumExecutablePath(),
    });

    try {
      for (const storyId of options.storyIds) {
        const page = await browser.newPage({
          viewport: { width: options.width, height: options.height },
        });
        const globals = options.globals.length
          ? `&globals=${encodeURIComponent(options.globals.join(";"))}`
          : "";
        await page.goto(
          `${origin}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story${globals}`,
          { waitUntil: "networkidle" },
        );
        // Recharts mounts on a ResponsiveContainer resize tick, so a settle
        // beat beats any single selector.
        await page.waitForTimeout(options.waitMs);

        if (options.hover) {
          const box = await page.locator(options.hover).first().boundingBox();
          if (box) {
            await page.mouse.move(
              box.x + box.width * options.hoverAt.x,
              box.y + box.height * options.hoverAt.y,
            );
            await page.waitForTimeout(400);
          } else {
            console.error(`  (no element matched ${options.hover})`);
          }
        }

        const file = path.join(options.outDir, `${storyId}.png`);
        await page.screenshot({ path: file, fullPage: true });
        await page.close();
        console.log(path.relative(repoRoot, file));
      }
    } finally {
      await browser.close();
    }
  } finally {
    stopServer?.();
  }
}

await main();
