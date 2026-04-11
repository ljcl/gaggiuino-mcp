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
        branches: 67.69,
        functions: 80.95,
        lines: 83.76,
        statements: 82.74,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
    },
  },
});
