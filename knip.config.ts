import type { KnipConfig } from "knip";

export default {
  workspaces: {
    "apps/server": {
      entry: ["src/index.ts"],
      project: ["src/**/*.ts"],
      ignore: ["**/*.test.ts", "**/__fixtures__/**"],
    },
    "packages/shot-graph": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
      ignore: ["vite-env.d.ts"],
    },
    "packages/design-system": {
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: ["@gaggiuino/tsconfig"],
    },
  },
  ignoreExportsUsedInFile: true,
  compilers: {
    css: (text: string) => {
      return [...text.matchAll(/@(?:import|plugin)\s+["']([^"']+)["']/g)]
        .map(([_, dep]) => `import "${dep}";`)
        .join("\n");
    },
  },
} satisfies KnipConfig;
