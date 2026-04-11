import { Legend, LegendItem } from "./Legend";
import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta<typeof Legend> = {
  component: Legend,
};

export default meta;
type Story = StoryObj<typeof Legend>;

export const Default: Story = {
  render: () => (
    <Legend>
      <LegendItem color="var(--chart-pressure)" label="Pressure" />
      <LegendItem color="var(--chart-flow)" label="Flow" />
      <LegendItem color="var(--chart-weight-flow)" label="Weight Flow" />
      <LegendItem color="var(--chart-weight)" label="Weight" />
    </Legend>
  ),
};

export const WithHidden: Story = {
  render: () => (
    <Legend>
      <LegendItem color="var(--chart-pressure)" label="Pressure" />
      <LegendItem color="var(--chart-flow)" label="Flow" hidden />
      <LegendItem color="var(--chart-weight-flow)" label="Weight Flow" />
      <LegendItem color="var(--chart-weight)" label="Weight" hidden />
    </Legend>
  ),
};

export const Touch: Story = {
  render: () => (
    <div style={{ maxWidth: 328 }}>
      <Legend size="touch">
        <LegendItem color="var(--chart-pressure)" label="Pressure" />
        <LegendItem color="var(--chart-flow)" label="Flow" />
        <LegendItem color="var(--chart-weight-flow)" label="Weight Flow" />
        <LegendItem color="var(--chart-weight)" label="Weight" />
      </Legend>
    </div>
  ),
};

export const WithComparison: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "center",
      }}
    >
      <Legend>
        <LegendItem color="var(--chart-pressure)" label="Pressure" />
        <LegendItem color="var(--chart-flow)" label="Flow" />
        <LegendItem color="var(--chart-weight-flow)" label="Weight Flow" />
        <LegendItem color="var(--chart-weight)" label="Weight" />
      </Legend>
      <Legend>
        <LegendItem
          color="var(--chart-pressure)"
          label="Pressure (cmp)"
          faded
        />
        <LegendItem color="var(--chart-flow)" label="Flow (cmp)" faded />
        <LegendItem
          color="var(--chart-weight-flow)"
          label="Weight Flow (cmp)"
          faded
        />
        <LegendItem color="var(--chart-weight)" label="Weight (cmp)" faded />
      </Legend>
    </div>
  ),
};
