/**
 * Simulated host CSS variable overrides for Storybook.
 *
 * In production, `useHostStyles()` injects these from the MCP host at runtime.
 * These presets let us preview how our UI looks in different hosts.
 */

export interface HostThemePreset {
  name: string;
  description: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Claude uses a warm off-white palette */
export const claudeTheme: HostThemePreset = {
  name: "Claude",
  description: "Anthropic Claude (warm off-white)",
  light: {
    "--color-background-primary": "#faf9f5",
    "--color-background-secondary": "#f0efe8",
    "--color-background-tertiary": "#e8e7df",
    "--color-text-primary": "#1a1915",
    "--color-text-secondary": "#4a4940",
    // Darkened from #7a7968 (4.19:1 on --color-background-primary, below
    // WCAG AA's 4.5:1 for normal text — found by the axe checks in the story
    // smoke tests). #737262 keeps the same warm hue at 4.62:1.
    "--color-text-tertiary": "#737262",
    "--color-border-primary": "rgba(31, 30, 29, 0.35)",
    "--color-border-secondary": "rgba(31, 30, 29, 0.2)",
    "--color-border-tertiary": "rgba(31, 30, 29, 0.1)",
    "--border-radius-md": "12px",
    "--border-radius-sm": "8px",
  },
  dark: {
    "--color-background-primary": "#2a2a28",
    "--color-background-secondary": "#1f1f1d",
    "--color-background-tertiary": "#151514",
    "--color-text-primary": "#f0efe8",
    "--color-text-secondary": "#b5b4aa",
    "--color-text-tertiary": "#8a897e",
    "--color-border-primary": "rgba(222, 220, 209, 0.35)",
    "--color-border-secondary": "rgba(222, 220, 209, 0.2)",
    "--color-border-tertiary": "rgba(222, 220, 209, 0.1)",
    "--border-radius-md": "12px",
    "--border-radius-sm": "8px",
  },
};

/** ChatGPT uses a cooler palette with rounded corners */
export const chatgptTheme: HostThemePreset = {
  name: "ChatGPT",
  description: "OpenAI ChatGPT (cool white)",
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f7f7f8",
    "--color-background-tertiary": "#ececf1",
    "--color-text-primary": "#0d0d0d",
    "--color-text-secondary": "#353740",
    "--color-text-tertiary": "#6e6e80",
    "--color-border-primary": "rgba(0, 0, 0, 0.15)",
    "--color-border-secondary": "rgba(0, 0, 0, 0.1)",
    "--color-border-tertiary": "rgba(0, 0, 0, 0.06)",
    "--border-radius-md": "16px",
    "--border-radius-sm": "8px",
    "--font-sans": "'Söhne', system-ui, -apple-system, sans-serif",
  },
  dark: {
    "--color-background-primary": "#212121",
    "--color-background-secondary": "#2f2f2f",
    "--color-background-tertiary": "#171717",
    "--color-text-primary": "#ececec",
    "--color-text-secondary": "#c5c5c5",
    "--color-text-tertiary": "#8e8ea0",
    "--color-border-primary": "rgba(255, 255, 255, 0.15)",
    "--color-border-secondary": "rgba(255, 255, 255, 0.1)",
    "--color-border-tertiary": "rgba(255, 255, 255, 0.06)",
    "--border-radius-md": "16px",
    "--border-radius-sm": "8px",
    "--font-sans": "'Söhne', system-ui, -apple-system, sans-serif",
  },
};

export const HOST_THEMES: Record<string, HostThemePreset | null> = {
  none: null,
  claude: claudeTheme,
  chatgpt: chatgptTheme,
};
