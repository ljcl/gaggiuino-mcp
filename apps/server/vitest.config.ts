import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Every handler in the suite mocks http://gaggiuino.local, and client.ts
    // reads GAGGIUINO_URL once, at module load. Pinned here because Bun loads
    // apps/server/.env into every test worker on its own (Node does not), and
    // that file is the developer's real deployment config: with it present,
    // `bun run test` sent every request to their actual machine's URL, MSW
    // refused each one, and 106 tests failed while CI (no .env) passed.
    env: { GAGGIUINO_URL: "http://gaggiuino.local" },
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
        branches: 96,
        functions: 100,
        lines: 99.9,
        statements: 99.7,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test-setup.ts",
        "src/mcpTestClient.ts",
        "src/index.ts",
      ],
    },
  },
});
