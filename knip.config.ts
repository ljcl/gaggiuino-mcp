import { type KnipConfig } from "knip";

export default {
  workspaces: {
    "apps/server": {
      entry: ["src/index.ts", "scripts/generate-schemas.ts"],
      project: ["src/**/*.ts"],
      ignore: ["**/*.test.ts", "**/__fixtures__/**"],
      // Resolved at runtime via createRequire(...).resolve("@gaggiuino/shot-graph/app.html"),
      // which knip cannot trace as a static import.
      ignoreDependencies: ["@gaggiuino/shot-graph"],
    },
    "packages/shot-graph": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
      ignore: ["vite-env.d.ts"],
    },
    "packages/ui": {
      project: ["src/**/*.{ts,tsx}"],
      // Consumed via `@import "@gaggiuino/design-system/tokens.css"` in this
      // package's CSS Modules (Legend/Skeleton/Tooltip). Knip's css compiler
      // does resolve and compile those files, but does not credit the
      // resulting import back to this workspace's package.json, so the
      // dependency still reports as unused without this override.
      ignoreDependencies: ["@gaggiuino/design-system"],
    },
    "packages/design-system": {
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: ["@gaggiuino/tsconfig"],
    },
    "packages/vite-config": {
      entry: ["mcp-app.ts"],
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
      // Consumed by Storybook's `stories` directory globs at build time (the
      // story files are co-located in each package and import relatively), so
      // there is no static import for knip to follow.
      ignoreDependencies: ["@gaggiuino/shot-graph", "@gaggiuino/ui"],
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
