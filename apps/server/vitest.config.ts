import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      enabled: false,
      reporter: ["text", "json-summary"],
      // Raised by `scripts/coverage-ratchet.ts` (run by the root
      // `test:coverage`), never by hand and no longer by vitest's own
      // `autoUpdate`. Values are floored to a tenth of a point so an edit
      // that moves one line out of the covered set cannot fail a re-run
      // against a threshold the previous run wrote sixty seconds earlier.
      // See AGENTS.md "Test coverage".
      thresholds: {
        branches: 94.6,
        functions: 100,
        lines: 99.7,
        statements: 99.3,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
    },
  },
});
