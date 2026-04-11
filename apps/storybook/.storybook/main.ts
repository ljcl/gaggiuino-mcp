import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  framework: "@storybook/react-vite",
  addons: ["@storybook/addon-mcp"],
  stories: [
    {
      titlePrefix: "Shot Graph",
      directory: "../../../packages/shot-graph/src/",
    },
    { directory: "../../../packages/design-system/stories/" },
  ],
});
