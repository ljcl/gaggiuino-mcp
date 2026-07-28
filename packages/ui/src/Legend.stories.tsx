import { type Meta, type StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Legend, LegendItem } from "./Legend";

const meta: Meta<typeof Legend> = {
  component: Legend,
};

export default meta;
type Story = StoryObj<typeof Legend>;

/**
 * Mirrors the shot chart's own dash vocabulary. The legend is where the
 * non-color encoding is *taught*, so these are not decorative: a viewer who
 * cannot separate two series by hue reads the pattern here and matches it on
 * the chart.
 */
const SERIES = [
  { color: "var(--chart-pressure)", label: "Pressure" },
  { color: "var(--chart-flow)", label: "Flow" },
  { color: "var(--chart-weight-flow)", dash: "7 3", label: "Weight Flow" },
  { color: "var(--chart-weight)", dash: "1 3", label: "Weight" },
] as const;

export const Default: Story = {
  render: () => (
    <Legend label="Shot series">
      {SERIES.map((s) => (
        <LegendItem key={s.label} {...s} />
      ))}
    </Legend>
  ),
};

export const WithHidden: Story = {
  render: () => (
    <Legend label="Shot series">
      {SERIES.map((s) => (
        <LegendItem key={s.label} {...s} hidden={s.label !== "Pressure"} />
      ))}
    </Legend>
  ),
};

export const Touch: Story = {
  render: () => (
    <div style={{ maxWidth: 328 }}>
      <Legend label="Shot series" size="touch">
        {SERIES.map((s) => (
          <LegendItem key={s.label} {...s} />
        ))}
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
      <Legend label="Shot series">
        {SERIES.map((s) => (
          <LegendItem key={s.label} {...s} />
        ))}
      </Legend>
      <Legend label="Comparison shot series">
        {SERIES.map((s) => (
          <LegendItem key={s.label} {...s} faded label={`${s.label} (cmp)`} />
        ))}
      </Legend>
    </div>
  ),
};

function ToggleableLegend() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  return (
    <Legend label="Shot series">
      {SERIES.map((s) => (
        <LegendItem
          key={s.label}
          {...s}
          hidden={hidden.has(s.label)}
          onClick={() =>
            setHidden((prev) => {
              const next = new Set(prev);
              if (next.has(s.label)) next.delete(s.label);
              else next.add(s.label);
              return next;
            })
          }
        />
      ))}
    </Legend>
  );
}

/**
 * `aria-pressed` is the only signal that reaches a screen reader — the
 * strikethrough is invisible to it — so the toggle state is asserted rather
 * than eyeballed.
 */
export const TogglesReportPressedState: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pressure = canvas.getByRole("button", { name: "Pressure" });
    expect(pressure).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(pressure);
    expect(pressure).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(pressure);
    expect(pressure).toHaveAttribute("aria-pressed", "true");

    // The group is named, so "Flow" is announced as part of a set rather than
    // as a loose button of unknown provenance.
    expect(
      canvas.getByRole("list", { name: "Shot series" }),
    ).toBeInTheDocument();
  },
  render: () => <ToggleableLegend />,
};
