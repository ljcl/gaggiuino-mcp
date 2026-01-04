import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      enabled: true,
      thresholds: {
        autoUpdate: true,
        branches: 64.1,
        functions: 80.95,
        lines: 81.54,
        statements: 80.63,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
    },
  },
});
