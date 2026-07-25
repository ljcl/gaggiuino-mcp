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
