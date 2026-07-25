import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  framework: "@storybook/react-vite",
  addons: [
    "@storybook/addon-mcp",
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
  ],
  stories: [
    {
      titlePrefix: "Shot Graph",
      directory: "../../../packages/shot-graph/src/",
    },
    {
      titlePrefix: "UI",
      directory: "../../../packages/ui/src/",
    },
    { directory: "../../../packages/design-system/stories/" },
  ],
});
