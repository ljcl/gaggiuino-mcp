import {
  londiniumShot32,
  londiniumShot33,
  quickShot,
} from "./__fixtures__/chart-data";
import { extractAnnotations, extractMeta, toChartData } from "./normalize";
import { ShotGraph } from "./ShotGraph";
import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta<typeof ShotGraph> = {
  component: ShotGraph,
  parameters: {
    // layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ShotGraph>;

export const SingleShot: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
  },
};

export const SecondShot: Story = {
  args: {
    data: toChartData(londiniumShot32),
    primaryMeta: extractMeta(londiniumShot32),
    annotations: extractAnnotations(londiniumShot32),
  },
};

export const Comparison: Story = {
  args: {
    data: toChartData(londiniumShot33, londiniumShot32),
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    annotations: extractAnnotations(londiniumShot33),
  },
};

export const PhaseBoundaries: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    phaseBoundaries: [5, 15],
    annotations: extractAnnotations(londiniumShot33),
  },
};

export const MinimalData: Story = {
  args: {
    data: toChartData(quickShot),
    primaryMeta: extractMeta(quickShot),
    annotations: extractAnnotations(quickShot),
  },
};

export const DarkTheme: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
  },
  decorators: [
    (Story) => (
      <div
        className="dark"
        style={{
          background: "var(--color-background-primary)",
          padding: "24px",
          borderRadius: "var(--border-radius-md)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
