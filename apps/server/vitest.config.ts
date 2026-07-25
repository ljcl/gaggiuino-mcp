import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      enabled: false,
      reporter: ["text", "json-summary"],
      thresholds: {
        autoUpdate: true,
        branches: 67,
        functions: 80.95,
        lines: 82.91,
        statements: 81.97,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
    },
  },
});
