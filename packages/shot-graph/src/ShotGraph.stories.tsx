import { useState } from "react";
import { fn } from "storybook/test";
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
    comparisonAnnotations: extractAnnotations(londiniumShot32),
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
  globals: {
    backgrounds: { value: "dark" },
    hostTheme: "claude",
  },
};

// --- Interactive stories for compare button ---

/** Shows the "Compare previous" button, logs click to Actions panel */
export const CompareButton: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
    onRequestCompare: fn(),
  },
};

/** Shows the loading state of the compare button */
export const CompareLoading: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
    onRequestCompare: fn(),
    compareLoading: true,
  },
};

/** Shows comparison with a dismiss button, logs click to Actions panel */
export const CompareWithDismiss: Story = {
  args: {
    data: toChartData(londiniumShot33, londiniumShot32),
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    annotations: extractAnnotations(londiniumShot33),
    comparisonAnnotations: extractAnnotations(londiniumShot32),
    onDismissCompare: fn(),
  },
};

/** Shows |----| connector bars between paired annotations from two shots */
export const AnnotationConnectors: Story = {
  args: {
    data: toChartData(londiniumShot33, londiniumShot32),
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    annotations: [
      {
        time: 2.5,
        value: 0.6,
        yAxisId: "right",
        label: "First drip",
        color: "var(--chart-weight)",
        metric: "firstDrip",
      },
      {
        time: 16.3,
        value: 9.3,
        yAxisId: "left",
        label: "9.3 bar",
        color: "var(--chart-pressure)",
        metric: "peakPressure",
      },
    ],
    comparisonAnnotations: [
      {
        time: 0.8,
        value: 5,
        yAxisId: "right",
        label: "First drip",
        color: "var(--chart-weight)",
        metric: "firstDrip",
      },
      {
        time: 12,
        value: 8.1,
        yAxisId: "left",
        label: "8.1 bar",
        color: "var(--chart-pressure)",
        metric: "peakPressure",
      },
    ],
  },
};

/** Fully interactive: click "Compare previous" to overlay shot 32, click "x" to dismiss */
export const Interactive: Story = {
  render: () => {
    const [showComparison, setShowComparison] = useState(false);
    const [loading, setLoading] = useState(false);
    const data = showComparison
      ? toChartData(londiniumShot33, londiniumShot32)
      : toChartData(londiniumShot33);
    const handleCompare = () => {
      setLoading(true);
      setTimeout(() => {
        setShowComparison(true);
        setLoading(false);
      }, 1000);
    };
    return (
      <ShotGraph
        data={data}
        primaryMeta={extractMeta(londiniumShot33)}
        comparisonMeta={
          showComparison ? extractMeta(londiniumShot32) : undefined
        }
        annotations={extractAnnotations(londiniumShot33)}
        comparisonAnnotations={
          showComparison ? extractAnnotations(londiniumShot32) : undefined
        }
        onRequestCompare={showComparison ? undefined : handleCompare}
        onDismissCompare={
          showComparison ? () => setShowComparison(false) : undefined
        }
        compareLoading={loading}
      />
    );
  },
};

export const MobileSingle: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
};

export const MobileComparison: Story = {
  args: {
    data: toChartData(londiniumShot33, londiniumShot32),
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    annotations: extractAnnotations(londiniumShot33),
    comparisonAnnotations: extractAnnotations(londiniumShot32),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
};
