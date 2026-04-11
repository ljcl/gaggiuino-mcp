# Standalone Storybook App — Design

**Date:** 2026-04-11
**Status:** Approved, ready to implement

## Goal

Move Storybook out of `packages/shot-graph/` into a first-class workspace at `apps/storybook/` that serves stories from any package in the monorepo. Upgrade to Storybook 10.3.5 (latest stable). Wire into Turborepo. Mirror the patterns already proven in the sibling `strava-mcp` repo.

## Motivation

Today Storybook lives inside `packages/shot-graph/`, which conflates two concerns:

- The shot-graph package's job is to bundle a single-file MCP App HTML.
- Storybook is a development workshop that should serve stories from *any* package — design-system, future MCP apps, future shared UI.

Embedding Storybook in `shot-graph/` forces every Storybook dep into that package, duplicates `.storybook/` config if a second package ever wants stories, and makes the shot-graph package harder to reason about. The strava-mcp repo already solved this exact problem with `apps/storybook/`; we are porting the pattern.

The shot-graph component uses `useHostStyles` to pick up MCP host CSS variables at runtime, so the new Storybook should also include strava-mcp's host-theme switcher (preview Claude vs ChatGPT visual treatments) — that's where most of the value lives.

## Target Structure

```
gaggiuino-mcp/
├── apps/
│   ├── server/                       (unchanged)
│   └── storybook/                    NEW
│       ├── .storybook/
│       │   ├── main.ts
│       │   └── preview.tsx
│       ├── package.json              (@gaggiuino/storybook)
│       └── tsconfig.json
├── packages/
│   ├── design-system/
│   │   ├── src/
│   │   │   ├── host-themes.ts        NEW
│   │   │   ├── index.ts              (re-export host-themes)
│   │   │   ├── tokens.css
│   │   │   └── tokens.ts
│   │   └── stories/                  (unchanged)
│   ├── shot-graph/
│   │   ├── .storybook/               DELETED
│   │   ├── src/ShotGraph.stories.tsx (unchanged in place)
│   │   ├── package.json              (storybook deps removed)
│   │   └── vite.config.ts            (imports @gaggiuino/vite-config)
│   ├── vite-config/                  NEW
│   │   ├── mcp-app.ts
│   │   └── package.json              (@gaggiuino/vite-config)
│   └── tsconfig/                     (unchanged)
```

## Key Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Storybook version | `^10.3.5` | Latest stable; no breaking changes to APIs we use |
| Stories config | `defineMain({ stories: [{ titlePrefix, directory }] })` | Storybook 10 idiomatic; explicit sidebar grouping; matches strava-mcp |
| Preview richness | Host-theme switcher (Claude/ChatGPT) + light/dark | Shot-graph uses `useHostStyles`; preview parity is the main payoff |
| Dark theme selector | `<div className={isDark ? "dark" : ""}>` | Gaggiuino tokens.css uses `.dark` class, not `[data-theme="dark"]` |
| `--shadow-*` tokens | Drop from host-themes.ts port | Gaggiuino tokens.css doesn't declare shadows; YAGNI |
| Vite config sharing | New `@gaggiuino/vite-config` package | Even with one MCP app today, extraction keeps shot-graph's vite config trivial and gives a home for future shared build helpers |
| `build-storybook` task | Add it now alongside `storybook` dev task | Cached static build is cheap to wire; useful for any future deploy/CI |

## Component Specs

### `apps/storybook/package.json`

```json
{
  "name": "@gaggiuino/storybook",
  "private": true,
  "type": "module",
  "exports": {
    "./preview": "./.storybook/preview.tsx"
  },
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gaggiuino/design-system": "workspace:*",
    "gaggiuino-shot-graph": "workspace:*"
  },
  "devDependencies": {
    "@gaggiuino/tsconfig": "workspace:*",
    "@storybook/react-vite": "^10.3.5",
    "@types/react": "^19.2.11",
    "@types/react-dom": "^19.2.3",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "storybook": "^10.3.5",
    "typescript": "^5.9.3",
    "vite": "^7.3.1"
  }
}
```

Depending on `gaggiuino-shot-graph` (workspace) lets the central `main.ts` resolve its imports (global.css, fonts, types) when discovering stories from that package.

### `apps/storybook/.storybook/main.ts`

```ts
import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  framework: "@storybook/react-vite",
  stories: [
    { titlePrefix: "Shot Graph", directory: "../../../packages/shot-graph/src/" },
    { directory: "../../../packages/design-system/stories/" },
  ],
});
```

### `apps/storybook/.storybook/preview.tsx`

Ports strava-mcp's preview, swapping `data-theme="dark"` for the `.dark` class convention used in `@gaggiuino/design-system`.

```tsx
import { definePreview } from "@storybook/react-vite";
import {
  HOST_THEMES,
  type HostThemePreset,
} from "@gaggiuino/design-system/host-themes";
import "@gaggiuino/design-system/tokens.css";

const ALL_HOST_KEYS = new Set(
  Object.values(HOST_THEMES)
    .filter((t): t is HostThemePreset => t !== null)
    .flatMap((t) => [...Object.keys(t.light), ...Object.keys(t.dark)]),
);

export default definePreview({
  addons: [],
  globalTypes: {
    hostTheme: {
      description: "Simulate MCP host CSS variable overrides",
      toolbar: {
        title: "Host Theme",
        icon: "paintbrush",
        items: [
          { value: "none", title: "Default (no host)" },
          { value: "claude", title: "Claude" },
          { value: "chatgpt", title: "ChatGPT" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "light" },
    hostTheme: "none",
  },
  decorators: [
    (StoryFn, context) => {
      const isDark = context.globals?.backgrounds?.value === "dark";
      const hostKey = (context.globals?.hostTheme as string) ?? "none";
      const theme = HOST_THEMES[hostKey] ?? null;
      const vars = theme ? (isDark ? theme.dark : theme.light) : {};

      const root = document.documentElement;
      for (const key of ALL_HOST_KEYS) root.style.removeProperty(key);
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
      document.body.style.cssText = theme
        ? "background: var(--color-background-primary) !important;"
        : "";

      return (
        <div className={isDark ? "dark" : ""}>
          <StoryFn />
        </div>
      );
    },
  ],
});
```

### `packages/design-system/src/host-themes.ts`

Verbatim port of strava-mcp's `host-themes.ts`, with `--shadow-sm` / `--shadow-md` keys removed (gaggiuino tokens don't declare them).

Token namespace is identical between strava-mcp and gaggiuino design-systems (`--color-background-primary`, `--color-text-primary`, `--color-border-primary`, `--border-radius-*`), so all other keys translate 1:1.

### `packages/design-system/package.json` exports addition

```json
"exports": {
  ".": "./src/index.ts",
  "./tokens.css": "./src/tokens.css",
  "./host-themes": "./src/host-themes.ts"
}
```

Also remove the now-unneeded `@storybook/react` devDependency that was only there to type the previous `Preview` import.

### `packages/vite-config/package.json`

```json
{
  "name": "@gaggiuino/vite-config",
  "private": true,
  "type": "module",
  "exports": {
    "./mcp-app": "./mcp-app.ts"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^5.1.3",
    "vite-plugin-singlefile": "^2.3.0"
  },
  "peerDependencies": {
    "vite": "^7.0.0"
  }
}
```

### `packages/vite-config/mcp-app.ts`

```ts
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Shared Vite config for Gaggiuino MCP Apps.
 *
 * When INPUT is set, builds the given HTML entry as a single-file bundle
 * suitable for serving as an MCP ui:// resource. Otherwise acts as a plain
 * React dev config.
 */
export function mcpAppConfig(outDir: string): UserConfig {
  const INPUT = process.env.INPUT;
  return defineConfig({
    plugins: [react(), ...(INPUT ? [viteSingleFile()] : [])],
    build: INPUT
      ? {
          rollupOptions: { input: INPUT },
          outDir,
          emptyOutDir: false,
        }
      : {},
  }) as UserConfig;
}
```

### `packages/shot-graph/vite.config.ts` (rewired)

```ts
import { mcpAppConfig } from "@gaggiuino/vite-config/mcp-app";

export default mcpAppConfig("../../dist/shot-graph");
```

### `packages/shot-graph/package.json` changes

- Add `"@gaggiuino/vite-config": "workspace:*"` to devDependencies
- Drop `@vitejs/plugin-react` and `vite-plugin-singlefile` (now transitive via vite-config)
- Drop storybook devDependencies: `@storybook/react`, `@storybook/react-vite`, `storybook`
- Drop scripts: `storybook`, `build-storybook`
- Delete `packages/shot-graph/.storybook/` directory

The shot-graph build contract is unchanged: still produces `dist/shot-graph/app.html` via `INPUT=app.html bunx vite build`. Server's HTML resolution path is untouched.

### `turbo.json`

```json
{
  "$schema": "https://turborepo.dev/schema.v2.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": {},
    "//#lint": { "outputs": [] },
    "dev": {
      "persistent": true,
      "cache": false,
      "env": ["GAGGIUINO_URL", "PORT", "HOST"]
    },
    "storybook": {
      "persistent": true,
      "cache": false
    },
    "build-storybook": {
      "dependsOn": ["^build"],
      "outputs": ["storybook-static/**"]
    }
  }
}
```

### Root `package.json` scripts

```json
"storybook": "turbo run storybook --filter=@gaggiuino/storybook",
"build-storybook": "turbo run build-storybook --filter=@gaggiuino/storybook"
```

### Root `.gitignore`

Add: `apps/storybook/storybook-static/`

## Implementation Sequence

Order chosen so each step leaves the repo in a green state.

1. **Extract `@gaggiuino/vite-config`.** Create the package, rewire shot-graph's `vite.config.ts`. Verify `bun run build` still produces a byte-identical `dist/shot-graph/app.html`.
2. **Add `host-themes.ts` to design-system.** Port from strava-mcp, drop shadow keys, update `index.ts` and `package.json` exports. No runtime consumer yet — purely additive.
3. **Scaffold `apps/storybook/`.** Create package + `.storybook/main.ts` + `.storybook/preview.tsx` + `tsconfig.json`. Install Storybook `^10.3.5`.
4. **Strip storybook from `packages/shot-graph/`.** Delete `.storybook/`, remove deps and scripts. Audit `ShotGraph.stories.tsx` for theme wiring that conflicts with the new global decorator and remove if found.
5. **Wire turborepo + root scripts + gitignore.**
6. **Verify end-to-end.** See verification checklist below.

## Verification Checklist

- [ ] `bun install` clean (no peer dep warnings introduced)
- [ ] `bun run storybook` launches; sidebar shows Shot Graph + design-system stories
- [ ] Host Theme toolbar switches Claude/ChatGPT presets correctly
- [ ] Backgrounds toggle composes with host themes (light/dark × none/claude/chatgpt)
- [ ] `bun run build-storybook` produces `apps/storybook/storybook-static/`
- [ ] `bun run build` produces `dist/shot-graph/app.html` identical in size/structure to before
- [ ] `bun run test` passes
- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes (where defined)

## Out of Scope (YAGNI)

- Visual regression testing (Chromatic, Playwright snapshots)
- Storybook addons beyond built-in toolbar/backgrounds
- Deploying `storybook-static/` anywhere
- Migrating `ShotGraph.stories.tsx` structure — keep as-is, just discovered via new `main.ts`
- Vite 8 upgrade (Storybook 10.3 added support, but Vite 7 still works fine)

## Storybook 10.3 Upgrade Notes

Verified against the upstream changelog: **no breaking changes** between 10.2.6 and 10.3.5 for `defineMain`, `definePreview`, `globalTypes.toolbar`, `initialGlobals`, or `backgrounds` APIs. The major 10.3 additions (Storybook MCP, Vite 8 support, ESLint 10 support, Tailwind v4 in addon-pseudo-states) are all additive and irrelevant to this work. Treat the bump as a drop-in.
