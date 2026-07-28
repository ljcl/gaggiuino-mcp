import {
  HOST_THEMES,
  type HostThemePreset,
} from "@gaggiuino/design-system/host-themes";
import a11y from "@storybook/addon-a11y";
import docs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import "@gaggiuino/design-system/tokens.css";
import "@gaggiuino/shot-graph/global.css";

/** Collect every CSS variable key used across all theme presets */
const ALL_HOST_KEYS = new Set(
  Object.values(HOST_THEMES)
    .filter((t): t is HostThemePreset => t !== null)
    .flatMap((t) => [...Object.keys(t.light), ...Object.keys(t.dark)]),
);

export default definePreview({
  addons: [a11y(), docs()],
  parameters: {
    /*
     * Every story runs axe-core through addon-a11y's Vitest integration. The
     * addon defaults to "todo", which records a violation and passes anyway;
     * "error" makes it fail `bun run test:stories`, so an accessibility
     * regression is caught the same way a broken render is.
     *
     * This gates every story in the repo, design-system docs included — a
     * story added without a label or with unreadable contrast fails CI.
     */
    a11y: { test: "error" },
    layout: "padded",
    viewport: {
      options: {
        iphone16pro: {
          name: "iPhone 16 Pro",
          styles: { width: "402px", height: "874px" },
          type: "mobile",
        },
        claudeIosCard: {
          name: "Claude iOS Card",
          styles: { width: "360px", height: "780px" },
          type: "mobile",
        },
      },
    },
  },
  globalTypes: {
    hostTheme: {
      description: "Simulate MCP host CSS variable overrides",
      toolbar: {
        title: "Host Theme",
        icon: "paintbrush",
        items: [
          { value: "none", title: "Default (no host)" },
          { value: "claude", title: "Claude" },
          { value: "chatgpt", title: "ChatGPT" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "light" },
    hostTheme: "none",
  },
  decorators: [
    (StoryFn, context) => {
      const isDark = context.globals?.backgrounds?.value === "dark";
      const hostKey = (context.globals?.hostTheme as string) ?? "none";
      const theme = HOST_THEMES[hostKey] ?? null;
      const vars = theme ? (isDark ? theme.dark : theme.light) : {};

      // Mirror what useHostStyles does in production: applyDocumentTheme sets
      // `data-theme` plus `color-scheme` on documentElement, and
      // applyHostStyleVariables sets the host's overrides there too. Stories
      // must exercise the same mechanism, or a dark palette keyed on a
      // selector no host applies still looks correct here.
      const root = document.documentElement;
      root.setAttribute("data-theme", isDark ? "dark" : "light");
      root.style.colorScheme = isDark ? "dark" : "light";
      for (const key of ALL_HOST_KEYS) root.style.removeProperty(key);
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
      // The canvas always takes the resolved background, host theme or not.
      // Scoping this to `theme` left the dark stories drawing dark-mode text
      // on Storybook's white canvas — a 1.05:1 combination that exists in no
      // real host, but which every story's axe check faithfully reported.
      document.body.style.cssText =
        "background: var(--color-background-primary) !important;";

      return <StoryFn />;
    },
  ],
});

/**
 * Project-wide autodocs. Must be a literal named export in the project's own
 * preview file. Storybook merges named preview exports with the default, and
 * the docs indexer reads the tag from here.
 */
export const tags = ["autodocs"];
