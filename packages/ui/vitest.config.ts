import { defineConfig } from "vitest/config";

/**
 * Unit tests for this package's pure host-plumbing helpers. Components and
 * hooks are exercised by the story smoke tests in real Chromium
 * (`bun run test:stories`), which is why there is no DOM environment here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
