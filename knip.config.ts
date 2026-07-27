import { type KnipConfig } from "knip";

// Only load-bearing overrides live here. Knip reports "configuration hints" for
// entries it does not need; keep this file hint-free so every remaining line
// documents something knip genuinely cannot work out on its own.
export default {
  workspaces: {
    "apps/server": {
      project: ["src/**/*.ts"],
      // Resolved at runtime via createRequire(...).resolve("@gaggiuino/shot-graph/app.html"),
      // which knip cannot trace as a static import.
      ignoreDependencies: ["@gaggiuino/shot-graph"],
    },
    "packages/shot-graph": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/ui": {
      project: ["src/**/*.{ts,tsx}"],
      // Consumed via `@import "@gaggiuino/design-system/tokens.css"` in this
      // package's CSS Modules (Legend/Skeleton/Tooltip). The css compiler below
      // resolves those imports, but knip does not credit them back to this
      // workspace's package.json, so the dependency reports as unused without
      // this override.
      ignoreDependencies: ["@gaggiuino/design-system"],
    },
    "packages/design-system": {
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/storybook": {
      storybook: {
        config: [".storybook/main.ts"],
        entry: [
          ".storybook/{manager,preview,index,vitest.setup}.{js,jsx,ts,tsx}",
          "../../packages/shot-graph/src/**/*.stories.@(ts|tsx)",
          "../../packages/ui/src/**/*.stories.@(ts|tsx)",
          "../../packages/design-system/stories/**/*.stories.@(ts|tsx)",
        ],
        project: [".storybook/**/*.{js,jsx,ts,tsx,mts}"],
      },
    },
  },
  ignoreExportsUsedInFile: true,
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/@(?:import|plugin)\s+["']([^"']+)["']/g)]
        .map(([_, dep]) => `import "${dep}";`)
        .join("\n"),
  },
} satisfies KnipConfig;
