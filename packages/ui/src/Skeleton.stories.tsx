import { Skeleton } from "./Skeleton";
import type { Meta, StoryObj } from "@storybook/react";

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
