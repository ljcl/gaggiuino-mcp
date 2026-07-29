import {
  compositeOver,
  contrastRatio,
  cvdSeparation,
  parseColor,
  type Rgb,
  simulateCvd,
} from "@gaggiuino/design-system/color";
import { type Meta, type StoryObj } from "@storybook/react";
import { expect } from "storybook/test";
import { COLORS, SERIES, TARGET_DASH } from "./constants";

/**
 * The chart palette's accessibility contract, asserted against what the
 * *browser* resolves rather than against the stylesheet text — so a host that
 * overrides `--chart-*` is measured too, and so a token pointed at a selector
 * nothing applies fails here instead of shipping.
 *
 * Two claims are checked, both from #36:
 *
 *  1. Every stroke clears 3:1 against the chart's own background, the WCAG
 *     1.4.11 floor for graphical objects.
 *  2. Every pair of strokes belonging to *different* metrics is separable —
 *     either by color under a protan and deutan simulation, or, where color
 *     cannot do it, by a different dash pattern.
 *
 * The second rule is why this is not simply a color test. The series do not
 * fit in the space a dichromat has left: simulated, `flow` and `weightFlow`
 * land ~3 ΔE00 apart no matter how the hues are chosen, unless one is pushed
 * to near-black. Pattern carries that pair, and this story is what stops a
 * later palette or dash edit from quietly removing the only channel that does.
 *
 * The stroke list is derived from the series registry rather than restated, so
 * every line the chart can draw is measured — the comparison overlay included.
 * That matters more than it sounds: comparison strokes carry their metric's
 * color, so the *only* thing separating `weightFlowCmp` from `pumpFlowCmp` is
 * the dash `comparisonDash` builds for them. Hand-listing the strokes is how a
 * new series ships unmeasured.
 */

/** ΔE00 under simulation below which two strokes need a second channel. */
const SEPARATION_FLOOR = 17;
/** WCAG 1.4.11 — graphical objects and UI components. */
const CONTRAST_FLOOR = 3;

interface Stroke {
  key: string;
  /** Strokes of one metric are meant to resemble each other. */
  metric: string;
  /** The CSS variable reference as the chart uses it. */
  color: string;
  /** `undefined` renders solid. */
  dash: string | undefined;
}

/** Goal lines have no registry entry — they track a metric, they are not one. */
const TARGET_STROKES: Stroke[] = [
  {
    color: COLORS.targetPressure,
    dash: TARGET_DASH,
    key: "targetPressure",
    metric: "pressure",
  },
  {
    color: COLORS.targetPumpFlow,
    dash: TARGET_DASH,
    key: "targetPumpFlow",
    metric: "pumpFlow",
  },
];

const STROKES: Stroke[] = [
  ...SERIES.map((s) => ({
    color: s.color,
    dash: s.dash,
    key: s.key,
    metric: s.metric.key,
  })),
  ...TARGET_STROKES,
];

/** Resolve a `var(--x)` reference through the browser to opaque channels. */
function resolve(cssValue: string, backdrop: Rgb): Rgb {
  const probe = document.createElement("div");
  probe.style.display = "none";
  probe.style.color = cssValue;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();

  const parsed = parseColor(computed);
  if (!parsed)
    throw new Error(`could not parse "${cssValue}" (got "${computed}")`);
  return compositeOver(parsed.rgb, parsed.alpha, backdrop);
}

function chartBackdrop(): Rgb {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-background-primary")
    .trim();
  const parsed = parseColor(raw);
  if (!parsed) throw new Error(`unreadable chart background "${raw}"`);
  return parsed.rgb;
}

function assertPalette(theme: "light" | "dark") {
  expect(document.documentElement.dataset.theme).toBe(theme);
  const backdrop = chartBackdrop();
  const resolved = STROKES.map((s) => ({
    ...s,
    rgb: resolve(s.color, backdrop),
  }));

  for (const s of resolved) {
    const ratio = contrastRatio(s.rgb, backdrop);
    expect(
      `${s.key}: ${ratio.toFixed(2)}:1`,
      `${s.key} must clear ${CONTRAST_FLOOR}:1 against the chart background in ${theme}`,
    ).toBe(`${s.key}: ${Math.max(ratio, CONTRAST_FLOOR).toFixed(2)}:1`);
  }

  for (const [i, a] of resolved.entries()) {
    for (const b of resolved.slice(i + 1)) {
      // A goal line is supposed to read as its own metric's stroke.
      if (a.metric === b.metric) continue;
      const separation = cvdSeparation(a.rgb, b.rgb);
      const distinguished = separation >= SEPARATION_FLOOR || a.dash !== b.dash;
      expect(
        `${a.key} vs ${b.key}: ${distinguished ? "separated" : `ΔE00 ${separation.toFixed(1)} and both dashed "${a.dash ?? "solid"}"`}`,
        `${a.key} and ${b.key} are indistinguishable in ${theme}: color separation is ` +
          `${separation.toFixed(1)} ΔE00 under protan/deutan (floor ${SEPARATION_FLOOR}) and ` +
          `neither carries a distinct dash pattern`,
      ).toBe(`${a.key} vs ${b.key}: separated`);
    }
  }
}

/** Swatch row showing each stroke as it renders and as a dichromat sees it. */
function Row({ stroke, backdrop }: { stroke: Stroke; backdrop: Rgb | null }) {
  const simulated = backdrop
    ? (["protan", "deutan"] as const).map((t) => {
        const rgb = simulateCvd(resolve(stroke.color, backdrop), t);
        return { rgb: `rgb(${rgb.join(",")})`, type: t };
      })
    : [];
  return (
    <tr>
      <td style={{ padding: "6px 12px 6px 0" }}>
        <code style={{ fontSize: "var(--font-text-xs-size)" }}>
          {stroke.key}
        </code>
      </td>
      {[{ rgb: stroke.color, type: "as rendered" }, ...simulated].map((s) => (
        <td key={s.type} style={{ padding: "6px 12px 6px 0" }}>
          <svg aria-hidden="true" height="12" width="120">
            <line
              stroke={s.rgb}
              strokeDasharray={stroke.dash}
              strokeWidth="2.5"
              x1="0"
              x2="120"
              y1="6"
              y2="6"
            />
          </svg>
        </td>
      ))}
    </tr>
  );
}

function ChartPalette() {
  const backdrop = typeof document === "undefined" ? null : chartBackdrop();
  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: "24px" }}>
      <table
        style={{
          borderCollapse: "collapse",
          color: "var(--color-text-primary)",
        }}
      >
        <thead>
          <tr
            style={{ fontSize: "var(--font-text-xs-size)", textAlign: "left" }}
          >
            <th style={{ padding: "6px 12px 6px 0" }}>Stroke</th>
            <th style={{ padding: "6px 12px 6px 0" }}>As rendered</th>
            <th style={{ padding: "6px 12px 6px 0" }}>Protanopia</th>
            <th style={{ padding: "6px 12px 6px 0" }}>Deuteranopia</th>
          </tr>
        </thead>
        <tbody>
          {STROKES.map((s) => (
            <Row backdrop={backdrop} key={s.key} stroke={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `titlePrefix: "Shot Graph"` in .storybook/main.ts already namespaces this
// directory; naming it again would nest it under a second "Shot Graph".
const meta: Meta = {
  component: ChartPalette,
  title: "Chart accessibility",
};

export default meta;
type Story = StoryObj;

export const Light: Story = {
  globals: { backgrounds: { value: "light" } },
  play: () => assertPalette("light"),
};

export const Dark: Story = {
  globals: { backgrounds: { value: "dark" } },
  play: () => assertPalette("dark"),
};
