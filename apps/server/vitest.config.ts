import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      enabled: false,
      reporter: ["text", "json-summary"],
      // Measured on a CLEAN checkout (what CI sees). Do not commit numbers
      // ratcheted on a machine that has `*.local.yaml` overrides present:
      // loader.ts's override-merge branches only execute when those files
      // exist, so a dev machine reports ~2 points higher than CI can ever
      // reach, and CI then fails on main. See AGENTS.md "Test coverage".
      thresholds: {
        autoUpdate: true,
        branches: 82.3,
        functions: 100,
        lines: 95.38,
        statements: 95.3,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
    },
  },
});
