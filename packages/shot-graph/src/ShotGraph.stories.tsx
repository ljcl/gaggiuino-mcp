import {
  AppShell,
  DownloadIcon,
  ExpandIcon,
  ToolbarButton,
} from "@gaggiuino/ui";
import { type Meta, type StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  emptyShot,
  londiniumShot32,
  londiniumShot33,
  quickShot,
  singleSampleShot,
} from "./__fixtures__/chart-data";
import {
  COMPARISON_SERIES,
  DEFAULT_HIDDEN_SERIES,
  PHASE_LABEL_CLASS,
} from "./constants";
import { extractAnnotations, extractMeta, toChartData } from "./normalize";
import { derivePhaseRegions } from "./phases";
import { ShotGraph } from "./ShotGraph";

/** Every `<Line>` recharts drew, by the dash pattern it rendered with. */
function renderedDashes(canvasElement: HTMLElement): (string | null)[] {
  return Array.from(
    canvasElement.querySelectorAll<SVGPathElement>(".recharts-line-curve"),
  ).map((curve) => curve.getAttribute("stroke-dasharray"));
}

/** A comparison stroke is any whose dash starts with the overlay's prefix. */
const COMPARISON_PREFIX = "10 4";

/**
 * Phase labels as rendered in the plot. Matched on their own class rather than
 * by text, for two reasons: "Flow" and "Pressure" are also legend entries — a
 * phase and the series that drives it are named the same thing on purpose — and
 * recharts hoists every label out of its `.recharts-reference-area` group into
 * a shared z-index layer, so there is nothing to walk down from.
 */
function renderedPhaseLabels(canvasElement: HTMLElement): string[] {
  return Array.from(
    canvasElement.querySelectorAll(`text.${PHASE_LABEL_CLASS}`),
  ).map((label) => label.textContent ?? "");
}

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

/**
 * The overlay has to be readable without hovering, which it was not while the
 * only thing separating a shot from its comparison was `opacity`. Each
 * comparison stroke now carries its metric's dash behind a long-dash prefix, so
 * the pairing survives greyscale, a projector, and a dichromat's palette.
 */
export const ComparisonStyling: Story = {
  args: Comparison.args,
  play: async ({ canvasElement }) => {
    const dashes = renderedDashes(canvasElement);
    const shown = COMPARISON_SERIES.filter(
      (s) => !DEFAULT_HIDDEN_SERIES.has(s.key),
    );

    // Every overlay on screen renders the dash the registry declares for it.
    await expect(
      dashes.filter((d) => d?.startsWith(COMPARISON_PREFIX)).sort(),
    ).toEqual(shown.map((s) => s.dash).sort());

    // And each one differs from the shot it overlays, which is the claim: a
    // comparison series is now readable as one without hovering it.
    for (const series of shown) {
      await expect(series.dash).not.toBe(series.metric.dash);
    }

    // Two overlays do share a dash — the two whose colours are furthest apart.
    // That is the accessibility contract working as designed, and the
    // "Chart accessibility" story is what measures the colour half of it.
    await expect(
      dashes.filter((d) => !d?.startsWith(COMPARISON_PREFIX)).length,
    ).toBeGreaterThan(0);
  },
};

/**
 * Phase regions labeled from `profile.phases[].type` — the machine sends the
 * names, so the chart shows them rather than unlabeled boundaries.
 */
export const PhaseRegions: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    phases: derivePhaseRegions(londiniumShot33),
    annotations: extractAnnotations(londiniumShot33),
  },
  play: async ({ canvasElement }) => {
    // The Londinium profile fills on a flow target, then extracts on pressure.
    await expect(renderedPhaseLabels(canvasElement)).toEqual([
      "Flow",
      "Pressure",
    ]);
  },
};

/**
 * A single-phase profile: one region, no internal boundary. The old inference
 * drew a hairline at every target step regardless of what the profile said.
 */
export const SinglePhase: Story = {
  args: {
    data: toChartData(quickShot),
    primaryMeta: extractMeta(quickShot),
    phases: derivePhaseRegions(quickShot),
    annotations: extractAnnotations(quickShot),
  },
};

/**
 * Temperature is a fifth series on its own degrees axis, off until toggled on —
 * a card-sized chart has no room to spend on it unprompted.
 */
export const TemperatureSeries: Story = {
  args: {
    data: toChartData(londiniumShot33),
    primaryMeta: extractMeta(londiniumShot33),
    phases: derivePhaseRegions(londiniumShot33),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedDashes(canvasElement)).not.toContain("5 2 1 2");

    await userEvent.click(await canvas.findByText("Temperature"));
    await expect(renderedDashes(canvasElement)).toContain("5 2 1 2");

    // The degrees axis appears with the series, and inside the SVG: recharts
    // stacks it outboard of the weight axis, so the chart's negative right
    // margin has to give way or the ticks lay out past the right edge.
    const surface = canvasElement.querySelector("svg.recharts-surface");
    const chartWidth = Number(surface?.getAttribute("width") ?? 0);
    const degrees = Array.from(
      canvasElement.querySelectorAll(".recharts-cartesian-axis-tick-value"),
    ).filter((tick) => tick.textContent === "88");
    await expect(degrees).toHaveLength(1);
    await expect(
      Number(degrees[0]?.getAttribute("x") ?? chartWidth),
    ).toBeLessThan(chartWidth);
  },
};

export const MinimalData: Story = {
  args: {
    data: toChartData(quickShot),
    primaryMeta: extractMeta(quickShot),
    annotations: extractAnnotations(quickShot),
  },
};

/**
 * A shot the machine recorded but sent no datapoints for — a scale that never
 * reported, or a record truncated in flash. The header still names the shot and
 * the axes still draw; what must not happen is a blank card or a throw, which
 * is all a host would show for a shot that genuinely exists.
 */
export const NoDatapoints: Story = {
  args: {
    data: toChartData(emptyShot),
    primaryMeta: extractMeta(emptyShot),
    annotations: extractAnnotations(emptyShot),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The header reports honest zeroes rather than rendering a blank card.
    await expect(await canvas.findByText("0.0g in 0.0s")).toBeInTheDocument();
    // The narration describes an empty shot, not an imagined plot.
    await expect(await canvas.findByText(/over 0 seconds/)).toBeInTheDocument();
    // No annotation invented to fill the gap.
    await expect(
      canvasElement.querySelectorAll(".recharts-reference-dot"),
    ).toHaveLength(0);
  },
};

/**
 * One datapoint: recharts has a line to draw with no second point to draw it
 * to. The chart is still the honest rendering of a shot that stopped after a
 * single sample.
 */
export const SingleDatapoint: Story = {
  args: {
    data: toChartData(singleSampleShot),
    primaryMeta: extractMeta(singleSampleShot),
    annotations: extractAnnotations(singleSampleShot),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/0.1s/)).toBeInTheDocument();
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

/**
 * Renders the story inside the same shell `main.tsx` mounts in the MCP app,
 * so mobile previews reflect what ships to hosts.
 */
function MobileCardShell({ children }: { children: React.ReactNode }) {
  return <AppShell mode="mobile">{children}</AppShell>;
}

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
  // layout: fullscreen removes Storybook's outer padding so the preview
  // matches what actually ships: the card sits directly against the
  // iframe edge, with only our 2px outer margin.
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MobileCardShell>
        <Story />
      </MobileCardShell>
    ),
  ],
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
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MobileCardShell>
        <Story />
      </MobileCardShell>
    ),
  ],
};

/**
 * The composition that actually ships: the shared shell, its toolbar of host
 * capabilities, and the chart inside it.
 */
export const InAppShell: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <AppShell
      actions={
        <>
          <ToolbarButton label="Export CSV" onClick={fn()}>
            <DownloadIcon />
          </ToolbarButton>
          <ToolbarButton
            label="Enter fullscreen"
            onClick={fn()}
            pressed={false}
          >
            <ExpandIcon />
          </ToolbarButton>
        </>
      }
      mode="desktop"
    >
      <ShotGraph
        annotations={extractAnnotations(londiniumShot33)}
        data={toChartData(londiniumShot33)}
        primaryMeta={extractMeta(londiniumShot33)}
      />
    </AppShell>
  ),
};

/**
 * Toggling a legend entry reports the new hidden set upward — the signal the
 * app debounces into `updateModelContext` so the model knows what is plotted.
 */
export const ReportsVisibilityChanges: Story = {
  args: {
    annotations: extractAnnotations(londiniumShot33),
    data: toChartData(londiniumShot33),
    onVisibilityChange: fn(),
    primaryMeta: extractMeta(londiniumShot33),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Pressure"));
    // Temperature is in the set because it starts hidden, not because the
    // click touched it.
    await expect(args.onVisibilityChange).toHaveBeenCalledWith(
      new Set(["temperature", "temperatureCmp", "pressure"]),
    );
  },
};

/**
 * The `hidden` prop, controlled by a parent across an unmount.
 *
 * This is the prop's whole reason for existing and it had no test. The app can
 * unmount this chart — switching to the pressure-against-flow view — and while
 * the hidden set lived only in here, that unmount reset it to the default while
 * `main.tsx`'s own copy, the one `updateModelContext` reports to the model, kept
 * the user's choices. The two diverged with nothing on screen or in a log to say
 * so: the model would describe temperature as plotted after the user had hidden
 * it, or the reverse.
 *
 * The remount below is what a view switch does. An uncontrolled chart fails the
 * final assertion.
 */
export const ControlledVisibility: Story = {
  render: function ControlledVisibilityStory() {
    const [hidden, setHidden] = useState<ReadonlySet<string>>(
      DEFAULT_HIDDEN_SERIES,
    );
    const [mounted, setMounted] = useState(true);
    return (
      <div>
        <button onClick={() => setMounted((m) => !m)} type="button">
          Toggle mount
        </button>
        {mounted && (
          <ShotGraph
            annotations={extractAnnotations(londiniumShot33)}
            data={toChartData(londiniumShot33)}
            hidden={hidden}
            onVisibilityChange={setHidden}
            primaryMeta={extractMeta(londiniumShot33)}
          />
        )}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const temperatureDash = "5 2 1 2";

    // Temperature starts hidden; showing it is a change the parent now owns.
    await expect(renderedDashes(canvasElement)).not.toContain(temperatureDash);
    await userEvent.click(await canvas.findByText("Temperature"));
    await expect(renderedDashes(canvasElement)).toContain(temperatureDash);

    // Unmount and remount, which is exactly what switching views does.
    const remount = await canvas.findByRole("button", { name: "Toggle mount" });
    await userEvent.click(remount);
    await expect(
      canvasElement.querySelectorAll(".recharts-line-curve"),
    ).toHaveLength(0);
    await userEvent.click(remount);

    // The parent's set survived, so the chart comes back as the user left it.
    await expect(renderedDashes(canvasElement)).toContain(temperatureDash);
  },
};
