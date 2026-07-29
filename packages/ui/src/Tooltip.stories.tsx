import { type Meta, type StoryObj } from "@storybook/react";
import { Tooltip, TooltipEntry } from "./Tooltip";

const meta: Meta<typeof Tooltip> = {
  component: Tooltip,
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const Default: Story = {
  render: () => (
    <Tooltip timestamp="00:23">
      <TooltipEntry
        color="var(--chart-pressure)"
        label="Pressure"
        value="9.1"
        unit="bar"
      />
      <TooltipEntry
        color="var(--chart-flow)"
        label="Flow"
        value="2.4"
        unit="ml/s"
      />
      <TooltipEntry
        color="var(--chart-weight)"
        label="Weight"
        value="18.2"
        unit="g"
      />
    </Tooltip>
  ),
};

export const SingleEntry: Story = {
  render: () => (
    <Tooltip timestamp="00:14">
      <TooltipEntry
        color="var(--chart-pressure)"
        label="Pressure"
        value="6.0"
        unit="bar"
      />
    </Tooltip>
  ),
};

/**
 * A comparison shot overlaid on the chart. The second reading sits on the same
 * row as the first, in tertiary text at full strength — fading it would put the
 * one thing on screen that spells out a number under the contrast floor.
 */
export const WithComparison: Story = {
  render: () => (
    <Tooltip timestamp="00:23">
      <TooltipEntry
        color="var(--chart-pressure)"
        comparison="8.4"
        label="Pressure"
        value="9.1"
        unit="bar"
      />
      <TooltipEntry
        color="var(--chart-flow)"
        comparison="2.1"
        label="Flow"
        value="2.4"
        unit="ml/s"
      />
      <TooltipEntry
        color="var(--chart-weight)"
        comparison="20.1"
        label="Weight"
        value="18.2"
        unit="g"
      />
    </Tooltip>
  ),
};

export const WithoutTimestamp: Story = {
  render: () => (
    <Tooltip>
      <TooltipEntry
        color="var(--chart-flow)"
        label="Flow"
        value="2.4"
        unit="ml/s"
      />
    </Tooltip>
  ),
};
