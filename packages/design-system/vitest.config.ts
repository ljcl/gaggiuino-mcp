import { defineConfig } from "vitest/config";

/**
 * Unit tests for `color.ts` — the maths behind the chart palette's
 * accessibility gate, asserted against published reference values.
 *
 * This package deliberately has no *component* tests: everything else here is
 * tokens and stories, and what is worth asserting about a token is what the
 * browser resolves it to, which the Storybook story tests measure in real
 * Chromium. There is no DOM environment here for the same reason.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
