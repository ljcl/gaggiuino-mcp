/**
 * Locate a usable Chromium for Playwright when the pinned build is missing.
 *
 * `bunx playwright install chromium` (what CI does) downloads the exact
 * revision the pinned Playwright expects, and in that normal case this module
 * does nothing. It exists for environments that ship a *pre-installed*
 * Chromium at a different revision and block the download — notably Claude
 * Code cloud sessions, where `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`
 * holds one build and the egress proxy refuses the fetch for any other. There
 * `bun run test:stories` would fail before rendering a single story, taking
 * the repo's only automated UI gate with it.
 *
 * The fallback only engages when Playwright's own executable is absent, so a
 * correctly provisioned machine (local or CI) always uses the pinned build and
 * behaviour is unchanged. A revision-skewed Chromium is fine for what we ask
 * of it — rendering stories and taking screenshots — and a slightly different
 * browser build is strictly better than no UI gate at all.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import path from "node:path";

/**
 * Binary names to probe inside a build's platform directory. Playwright has
 * renamed those directories across versions (`chrome-linux`, `chrome-linux64`,
 * `chrome-mac-arm64`, …), so we walk whatever children the build has rather
 * than hardcoding the layout of the version we happened to be written against.
 */
const BINARY_NAMES = [
  "chrome",
  "chrome.exe",
  "Chromium.app/Contents/MacOS/Chromium",
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell",
];

/** Build directories Playwright creates, e.g. `chromium-1194`. */
const BUILD_DIR_PATTERN = /^(chromium|chromium_headless_shell)-(\d+)$/;

/** Default download locations, checked when PLAYWRIGHT_BROWSERS_PATH is unset. */
function defaultBrowserRoots(): string[] {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [path.join(home, "Library/Caches/ms-playwright")];
    case "win32":
      return [path.join(home, "AppData/Local/ms-playwright")];
    default:
      return [path.join(home, ".cache/ms-playwright")];
  }
}

function browserRoots(): string[] {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" means "next to the package"; leave that case to Playwright itself.
  if (configured && configured !== "0") return [configured];
  return defaultBrowserRoots();
}

/** Every Chromium build under a root, newest revision first, full builds first. */
function buildDirs(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, match: BUILD_DIR_PATTERN.exec(name) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      const kindA = a.match![1] === "chromium" ? 0 : 1;
      const kindB = b.match![1] === "chromium" ? 0 : 1;
      if (kindA !== kindB) return kindA - kindB;
      return Number(b.match![2]) - Number(a.match![2]);
    })
    .map((entry) => path.join(root, entry.name));
}

/** The browser binary inside one build directory, if there is one. */
function findBinary(buildDir: string): string | undefined {
  let children: string[];
  try {
    children = readdirSync(buildDir);
  } catch {
    return undefined;
  }
  for (const child of children) {
    for (const name of BINARY_NAMES) {
      const executable = path.join(buildDir, child, name);
      if (existsSync(executable)) return executable;
    }
  }
  return undefined;
}

/**
 * Playwright's own pinned executable, or undefined if it is not installed.
 *
 * Loaded synchronously through `createRequire` — not a bare `require`, which
 * is undefined in real ESM, and not a top-level `import`, because this module
 * is evaluated by the Vitest config where a missing or half-installed
 * playwright should degrade to the scan rather than break config loading.
 */
function pinnedExecutable(): string | undefined {
  try {
    const { chromium } = createRequire(import.meta.url)(
      "playwright",
    ) as typeof import("playwright");
    const executable = chromium.executablePath();
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An `executablePath` for `chromium.launch()`, or `undefined` to let
 * Playwright resolve its own pinned build (the normal case — passing
 * `undefined` is the same as not passing the option at all).
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` overrides everything, for pointing at
 * a system Chrome by hand.
 */
export function resolveChromiumExecutablePath(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (override) return existsSync(override) ? override : undefined;

  if (pinnedExecutable()) return undefined;

  for (const root of browserRoots()) {
    for (const dir of buildDirs(root)) {
      const executable = findBinary(dir);
      if (executable) return executable;
    }
  }

  // Nothing found: return undefined so Playwright raises its own "run
  // playwright install" error, which says more than anything we could.
  return undefined;
}
