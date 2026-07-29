import { type Meta, type StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ChartTooltip } from "./ChartTooltip";

/**
 * The tooltip is a pure adapter over a recharts payload, so the stories feed it
 * payloads directly rather than hovering a chart — the interesting cases (a
 * genuine zero, a comparison overlay, a shot that ended early) are all about
 * what the payload contains, and hovering a specific timestamp to produce one
 * would be testing recharts' hit detection instead.
 *
 * Area fills and goal lines are absent here because they declare
 * `tooltipType="none"` on the chart and never reach the payload at all.
 */

/** Shape recharts hands to a custom tooltip: a dataKey, a value, a name. */
function entry(dataKey: string, value: number) {
  return { dataKey, name: dataKey, value };
}

const meta: Meta<typeof ChartTooltip> = {
  component: ChartTooltip,
};

export default meta;
type Story = StoryObj<typeof ChartTooltip>;

export const Default: Story = {
  args: {
    active: true,
    label: 23,
    payload: [
      entry("pressure", 9.12),
      entry("pumpFlow", 2.4),
      entry("weightFlow", 1.8),
      entry("shotWeight", 18.24),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every series names its unit. The `unit` prop existed on the shared
    // Tooltip and its stories demonstrated it; this adapter never passed one,
    // so four series on two axes all read as bare numbers.
    await expect(await canvas.findByText(/bar/)).toBeInTheDocument();
    await expect(await canvas.findByText(/ml\/s/)).toBeInTheDocument();
    await expect(await canvas.findByText(/g\/s/)).toBeInTheDocument();
    await expect(await canvas.findByText("00:23")).toBeInTheDocument();
  },
};

/**
 * Zero is a reading. Preinfusion holds flow at zero and every shot starts at
 * zero weight; the old `value !== 0` filter silently dropped both, so the
 * tooltip went blank exactly where the profile was doing something.
 */
export const ZeroReadings: Story = {
  args: {
    active: true,
    label: 3,
    payload: [
      entry("pressure", 2.0),
      entry("pumpFlow", 0),
      entry("weightFlow", 0),
      entry("shotWeight", 0),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByText("0.0")).toHaveLength(3);
  },
};

/**
 * The comparison case. While an overlay is on screen the tooltip is the one
 * place two shots can be read at the same instant — and it was the one place
 * that filtered the overlay out entirely.
 */
export const WithComparison: Story = {
  args: {
    active: true,
    label: 23,
    payload: [
      entry("pressure", 9.12),
      entry("pressureCmp", 8.44),
      entry("pumpFlow", 2.4),
      entry("pumpFlowCmp", 2.05),
      entry("shotWeight", 18.24),
      entry("shotWeightCmp", 20.1),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("9.1")).toBeInTheDocument();
    await expect(await canvas.findByText("vs 8.4")).toBeInTheDocument();
    await expect(await canvas.findByText("vs 20.1")).toBeInTheDocument();
    // One row per metric, not one per series: three metrics, three swatches.
    await expect(canvas.getByText(/bar/)).toBeInTheDocument();
  },
};

/**
 * The overlay outlasts the primary shot. Rather than hide the row — which would
 * make the longer shot look like it stopped too — the primary reading is an
 * em dash and the comparison still reports.
 */
export const ComparisonOutlastsPrimary: Story = {
  args: {
    active: true,
    label: 31,
    payload: [entry("pressureCmp", 6.2), entry("shotWeightCmp", 37.4)],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByText("—")).toHaveLength(2);
    await expect(await canvas.findByText("vs 6.2")).toBeInTheDocument();
  },
};

/** Temperature, once toggled on, reads in degrees like anything else. */
export const WithTemperature: Story = {
  args: {
    active: true,
    label: 23,
    payload: [entry("pressure", 9.12), entry("temperature", 93.4)],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/°C/)).toBeInTheDocument();
  },
};

/** Nothing to say: recharts still fires the tooltip on an empty payload. */
export const Inactive: Story = {
  args: { active: false, label: 0, payload: [] },
};
