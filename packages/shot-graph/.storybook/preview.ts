import type { Preview } from "@storybook/react";
import "@gaggiuino/design-system/tokens.css";
import "../src/global.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
  },
};

export default preview;
