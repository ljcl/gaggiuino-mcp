import { AppShell } from "@gaggiuino/ui";
import { type Meta, type StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import {
  emptyShot,
  londiniumShot32,
  londiniumShot33,
  quickShot,
} from "./__fixtures__/chart-data";
import { SERIES } from "./constants";
import { extractMeta, toChartData } from "./normalize";
import { PressureFlowPlot } from "./PressureFlowPlot";
import { type ChartDataPoint } from "./types";

/** Every `<Line>` recharts drew, as the (stroke, dash) pair it rendered with. */
function renderedStrokes(
  canvasElement: HTMLElement,
): { color: string; dash: string | null }[] {
  return Array.from(
    canvasElement.querySelectorAll<SVGPathElement>(".recharts-line-curve"),
  ).map((curve) => ({
    color: curve.getAttribute("stroke") ?? "",
    dash: curve.getAttribute("stroke-dasharray"),
  }));
}

/** The `x,y` pairs of a rendered curve, in the order the path visits them. */
function pathPoints(curve: SVGPathElement): { x: number; y: number }[] {
  return Array.from(
    (curve.getAttribute("d") ?? "").matchAll(
      /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    ),
  ).map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

/** How many separate subpaths a curve is drawn as. One `M` per break. */
function subpathCount(curve: SVGPathElement): number {
  return ((curve.getAttribute("d") ?? "").match(/M/g) ?? []).length;
}

const comparisonData = toChartData(londiniumShot33, londiniumShot32);

/** The comparison samples this plot draws, in the order it draws them. */
const comparisonTrace: ChartDataPoint[] = comparisonData.filter(
  (point) =>
    typeof point.pressureCmp === "number" &&
    typeof point.pumpFlowCmp === "number",
);

const meta: Meta<typeof PressureFlowPlot> = {
  component: PressureFlowPlot,
};

export default meta;
type Story = StoryObj<typeof PressureFlowPlot>;

/**
 * Pressure against flow for one shot, traced in time order.
 *
 * The `play` is the guard the component's docblock claims: this view adds no
 * stroke to the palette, because flow is an axis here rather than a series. If
 * that ever stops being true, the new stroke is one the Chart accessibility
 * story has never measured — and this fails rather than shipping an unmeasured
 * colour.
 */
export const SingleShot: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
  },
  play: async ({ canvasElement }) => {
    const strokes = renderedStrokes(canvasElement);
    await expect(strokes).toHaveLength(1);

    for (const stroke of strokes) {
      const registered = SERIES.find(
        (series) =>
          series.color === stroke.color &&
          (series.dash ?? null) === stroke.dash,
      );
      await expect(
        registered,
        `${stroke.color} / ${stroke.dash} is not a registry stroke`,
      ).toBeDefined();
    }

    // Flow is the horizontal axis, which is the whole difference from the time
    // chart. Asserted on the label rather than the ticks: an axis whose domain
    // happened to look like seconds would still be wrong.
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Flow (ml/s)")).toBeInTheDocument();
    await expect(await canvas.findByText("Pressure (bar)")).toBeInTheDocument();

    // The trace begins somewhere, and a loop drawn with no dots cannot say
    // where. This is the marker that makes the direction of travel readable.
    await expect(
      canvasElement.querySelectorAll(".recharts-reference-dot"),
    ).toHaveLength(1);
  },
};

/**
 * Every `var(--token)` this plot hands to an SVG attribute resolves.
 *
 * Not a style nitpick — a stroke naming a token that does not exist is an
 * *invalid* declaration, and `stroke` is an inherited property with an initial
 * value of black, so the element renders solid black in both themes rather than
 * disappearing or falling back. That shipped once here: `--color-border-subtle`
 * was never defined anywhere in the design system, and nothing noticed, because
 * the Chart accessibility gate only measures `--chart-*` series strokes and no
 * story looked at the furniture.
 */
export const TokensResolve: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
  },
  play: async ({ canvasElement }) => {
    const styles = getComputedStyle(document.documentElement);
    const referenced = new Set<string>();

    for (const node of canvasElement.querySelectorAll<SVGElement>("*")) {
      for (const attribute of ["stroke", "fill"]) {
        const value = node.getAttribute(attribute);
        for (const [, token] of (value ?? "").matchAll(/var\((--[\w-]+)\)/g)) {
          if (token) referenced.add(token);
        }
      }
    }

    // A plot that referenced no tokens at all would pass the loop below without
    // asserting anything, which is the failure mode this guards.
    await expect(referenced.size).toBeGreaterThan(2);

    for (const token of referenced) {
      await expect(
        styles.getPropertyValue(token).trim(),
        `${token} is referenced by the plot but defined nowhere`,
      ).not.toBe("");
    }
  },
};

/**
 * Two shots overlaid, each against **its own** flow.
 *
 * This is the part that is easy to get quietly wrong. Recharts takes x from a
 * single axis `dataKey`, so a comparison line left on the primary axis is
 * plotted against the *primary's* flow — pairing a pressure from one shot with
 * a flow from another, at every point, while looking entirely plausible. The
 * second hidden axis is what fixes it, and the two assertions below are what
 * would notice if it were removed:
 *
 * - The comparison trace draws a point per comparison sample. 73 of its 172
 *   samples sit on merged rows that carry no primary flow at all, so the wrong
 *   axis loses them.
 * - Its rightmost point is the sample with the highest `pumpFlowCmp` (index 5),
 *   not the highest `pumpFlow` among those rows (index 18).
 */
export const Comparison: Story = {
  args: {
    data: comparisonData,
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    onDismissCompare: fn(),
  },
  play: async ({ canvasElement }) => {
    const curves = Array.from(
      canvasElement.querySelectorAll<SVGPathElement>(".recharts-line-curve"),
    );
    await expect(curves).toHaveLength(2);

    // Rendered in JSX order: the comparison sits behind the primary. The dash
    // assertions below re-check that, so a reordering fails loudly rather than
    // silently testing the wrong curve.
    const points = pathPoints(curves[0] as SVGPathElement);
    await expect(points).toHaveLength(comparisonTrace.length);

    const rightmost = points.reduce(
      (best, point, index) => (point.x > (points[best]?.x ?? 0) ? index : best),
      0,
    );
    const highestOwnFlow = comparisonTrace.reduce(
      (best, point, index) =>
        (point.pumpFlowCmp ?? 0) > (comparisonTrace[best]?.pumpFlowCmp ?? 0)
          ? index
          : best,
      0,
    );
    await expect(rightmost).toBe(highestOwnFlow);

    // Both strokes are the pressure metric's colour; only the dash separates
    // them, which is the registry's own comparison encoding.
    await expect(curves[0]?.getAttribute("stroke")).toBe(
      curves[1]?.getAttribute("stroke"),
    );
    await expect(curves[0]?.getAttribute("stroke-dasharray")).toBe("10 4");
    await expect(curves[1]?.getAttribute("stroke-dasharray")).toBeNull();

    // One start marker each, so two overlaid loops can still be told apart at
    // the point where reading them together matters most.
    await expect(
      canvasElement.querySelectorAll(".recharts-reference-dot"),
    ).toHaveLength(2);
  },
};

/**
 * A shot whose flow series is shorter than its pressure series.
 *
 * Two different kinds of hole reach this component and they must not be treated
 * alike. A row the merge minted for the *other* shot says nothing about this one
 * and is dropped. A sample that recorded a pressure but no flow has no
 * horizontal position at all, so the trace has to **break** there — spanning it
 * would draw a path through the plane the shot never took.
 *
 * Recharts only breaks where a point is present in the array with a null
 * coordinate, so the tidy-looking implementation — filter out anything
 * incomplete — produces exactly the invented chord. This is the story that
 * tells the two apart: both fixtures ship equal-length arrays, so no real
 * capture exercises it.
 */
const HOLED_DATA: ChartDataPoint[] = [
  { pressure: 1, pumpFlow: 0.4, time: 0 },
  { pressure: 4, pumpFlow: 2.2, time: 1 },
  // Pressure kept reporting; the flow sensor did not.
  { pressure: 8, time: 2 },
  { pressure: 9, time: 3 },
  { pressure: 9.1, pumpFlow: 1.8, time: 4 },
  { pressure: 6, pumpFlow: 1.2, time: 5 },
];

export const IncompleteSamples: Story = {
  args: {
    data: HOLED_DATA,
    primaryMeta: {
      duration: 5,
      id: "901",
      profileName: "Sparse",
      weight: 30,
    },
  },
  play: async ({ canvasElement }) => {
    const curve = canvasElement.querySelector<SVGPathElement>(
      ".recharts-line-curve",
    );
    await expect(curve).not.toBeNull();

    // Two subpaths: the gap is a break in the stroke, not a chord across it.
    await expect(subpathCount(curve as SVGPathElement)).toBe(2);
    await expect(pathPoints(curve as SVGPathElement)).toHaveLength(4);

    // And the narration says so rather than quietly reporting four samples as
    // if they were the whole shot.
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        /2 samples recorded only one of the two readings/,
      ),
    ).toBeInTheDocument();
  },
};

/**
 * The narration describes the path, not a timeline.
 *
 * `describeChart` is time-domain in almost every sentence, and reusing it here
 * would confidently narrate seconds along an axis that measures millilitres per
 * second. This asserts the plot reaches for its own description instead.
 */
export const AccessibleDescription: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const plot = await canvas.findByRole("img", {
      name: /pressure against flow/i,
    });

    const description = canvasElement.querySelector(
      `#${CSS.escape(plot.getAttribute("aria-describedby") ?? "")}`,
    );
    await expect(description?.textContent).toContain("Parametric plot");
    await expect(description?.textContent).toContain("not a time");

    // `accessibilityLayer` is deliberately off: its only behaviour is moving a
    // tooltip, and this plot has none, so it would leave a focusable
    // `role="application"` that answers no key the user presses.
    // `accessibilityLayer` is opted out of, not merely omitted: recharts 3
    // turns it on by default, and its only behaviour is moving a tooltip this
    // plot does not have. Left on it stamps `role="application"` and
    // `tabIndex=0` on the surface — a focusable element that tells a screen
    // reader to stop intercepting keystrokes and then answers none of them,
    // nested inside a `role="img"` that declares the subtree presentational.
    await expect(
      canvasElement.querySelectorAll('[role="application"]'),
    ).toHaveLength(0);
    // Negative tabindex is fine and recharts puts it on a dozen layer groups;
    // what must not exist is a keyboard tab stop with nothing behind it.
    await expect(
      canvasElement.querySelectorAll('[tabindex]:not([tabindex="-1"])'),
    ).toHaveLength(0);
  },
};

/**
 * A shot the machine recorded but sent no datapoints for. The axes still draw
 * and the header still names the shot — the same honest empty frame
 * `ShotGraph`'s `NoDatapoints` renders, rather than a blank card for a shot that
 * genuinely exists. What must not happen is a narration describing a plot that
 * is not there.
 */
export const NoDatapoints: Story = {
  args: {
    data: toChartData(emptyShot),
    primaryMeta: extractMeta(emptyShot),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/No sample carries both a pressure and a flow/),
    ).toBeInTheDocument();
    // No start marker invented for a trace with no start.
    await expect(
      canvasElement.querySelectorAll(".recharts-reference-dot"),
    ).toHaveLength(0);
  },
};

/** A five-point shot: enough to draw, short enough to see every vertex. */
export const MinimalData: Story = {
  args: {
    data: toChartData(quickShot),
    primaryMeta: extractMeta(quickShot),
  },
};

export const DarkTheme: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
  },
  globals: {
    backgrounds: { value: "dark" },
    hostTheme: "claude",
  },
};

/** The shell `main.tsx` mounts in, so the mobile preview is what ships. */
function MobileCardShell({ children }: { children: React.ReactNode }) {
  return <AppShell mode="mobile">{children}</AppShell>;
}

export const MobileSingle: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MobileCardShell>
        <Story />
      </MobileCardShell>
    ),
  ],
  play: async ({ canvasElement }) => {
    // Both axes stay labelled at this width. The time chart can drop a label
    // because its legend names every series; this view has no legend, so an
    // unlabelled scale leaves nothing on screen saying what the numbers are.
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Flow (ml/s)")).toBeInTheDocument();
    await expect(await canvas.findByText("Pressure (bar)")).toBeInTheDocument();
  },
};

export const MobileComparison: Story = {
  args: {
    data: comparisonData,
    primaryMeta: extractMeta(londiniumShot33),
    comparisonMeta: extractMeta(londiniumShot32),
    mode: "mobile",
    onDismissCompare: fn(),
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MobileCardShell>
        <Story />
      </MobileCardShell>
    ),
  ],
};
