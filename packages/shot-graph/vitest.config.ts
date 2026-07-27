import { defineConfig } from "vitest/config";

/**
 * Unit tests for this app's pure helpers. The React surface is covered by the
 * story smoke tests in real Chromium (`bun run test:stories`), so there is no
 * DOM environment here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
