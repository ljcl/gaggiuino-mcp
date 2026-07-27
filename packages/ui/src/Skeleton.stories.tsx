import { type Meta, type StoryObj } from "@storybook/react";
import { Skeleton } from "./Skeleton";

const meta: Meta<typeof Skeleton> = {
  component: Skeleton,
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Chart: Story = {
  args: { variant: "chart" },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <Skeleton {...args} />
    </div>
  ),
};

/**
 * Slow-fetch state: once a request has run long enough that a silent shimmer
 * starts to read as a hang, the skeleton says what it is waiting for.
 */
export const SlowFetch: Story = {
  args: {
    message: "Still waiting on the machine…",
    variant: "chart",
  },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <Skeleton {...args} />
    </div>
  ),
};
