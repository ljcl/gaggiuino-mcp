import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { resolveChromiumExecutablePath } from "./scripts/playwright-chromium";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Story smoke tests (`bun run test:stories`): every Storybook story renders in
 * real headless Chromium via the Storybook Vitest addon. Per-package unit
 * tests stay as turbo `test` tasks with their own configs; this root config
 * owns only the story project.
 *
 * Deliberately NOT named vitest.config.ts: vitest searches parent directories
 * for a config, so a default-named root config would hijack every package's
 * bare `vitest run`. Only the explicit --config flag in the root test:stories
 * script loads it.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage-stories",
      // The storybookTest addon pins the project root to apps/storybook, so
      // every packages/* source is "external" to coverage; without this the
      // report is empty.
      allowExternal: true,
      exclude: [
        "**/*.stories.{ts,tsx}",
        "**/*.test.{ts,tsx}",
        "**/__fixtures__/**",
        "**/.storybook/**",
        "**/apps/storybook",
        "**/vite-env.d.ts",
        "**/*.d.ts",
      ],
    },
    projects: [
      {
        plugins: [
          storybookTest({
            configDir: path.join(dirname, "apps/storybook/.storybook"),
            storybookScript: "bun run storybook",
          }),
        ],
        test: {
          name: "storybook",
          // The addon pins the project root to apps/storybook (configDir/..)
          // but resolves story globs against this dir; both must agree or no
          // story files are found.
          dir: dirname,
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                executablePath: resolveChromiumExecutablePath(),
              },
            }),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
