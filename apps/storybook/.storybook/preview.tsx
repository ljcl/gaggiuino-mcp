import {
  HOST_THEMES,
  type HostThemePreset,
} from "@gaggiuino/design-system/host-themes";
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
  addons: [],
  parameters: {
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

      // Apply host CSS variables to :root (mirrors what useHostStyles does in production)
      const root = document.documentElement;
      for (const key of ALL_HOST_KEYS) root.style.removeProperty(key);
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
      // Set canvas background to host background when a theme is active
      document.body.style.cssText = theme
        ? "background: var(--color-background-primary) !important;"
        : "";

      // Gaggiuino's design-system uses `.dark` class (not [data-theme="dark"])
      return (
        <div className={isDark ? "dark" : ""}>
          <StoryFn />
        </div>
      );
    },
  ],
});
