import type { Meta, StoryObj } from "@storybook/react";
import "../src/tokens.css";

const textSamples = [
  {
    label: "Text XS",
    sizeVar: "--font-text-xs-size",
    lineHeightVar: "--font-text-xs-line-height",
    weight: "normal",
  },
  {
    label: "Text SM",
    sizeVar: "--font-text-sm-size",
    lineHeightVar: "--font-text-sm-line-height",
    weight: "normal",
  },
  {
    label: "Text MD",
    sizeVar: "--font-text-md-size",
    lineHeightVar: "--font-text-md-line-height",
    weight: "normal",
  },
];

const headingSamples = [
  {
    label: "Heading SM",
    sizeVar: "--font-heading-sm-size",
    weight: "semibold",
  },
  {
    label: "Heading MD",
    sizeVar: "--font-heading-md-size",
    weight: "semibold",
  },
];

const weightSamples = [
  { label: "Normal (400)", var: "--font-weight-normal" },
  { label: "Medium (500)", var: "--font-weight-medium" },
  { label: "Semibold (600)", var: "--font-weight-semibold" },
  { label: "Bold (700)", var: "--font-weight-bold" },
];

function TypographyShowcase() {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        padding: "24px",
        color: "var(--color-text-primary)",
      }}
    >
      <h2
        style={{
          fontSize: "var(--font-heading-md-size)",
          fontWeight: "var(--font-weight-semibold)",
          marginBottom: "24px",
        }}
      >
        Text Styles
      </h2>
      {textSamples.map((s) => (
        <div key={s.label} style={{ marginBottom: "16px" }}>
          <div
            style={{
              fontSize: `var(${s.sizeVar})`,
              lineHeight: s.lineHeightVar
                ? `var(${s.lineHeightVar})`
                : undefined,
              fontWeight: `var(--font-weight-${s.weight})`,
            }}
          >
            {s.label} — The quick brown fox jumps over the lazy dog
          </div>
          <code
            style={{
              fontSize: "var(--font-text-xs-size)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {s.sizeVar}
          </code>
        </div>
      ))}

      <h2
        style={{
          fontSize: "var(--font-heading-md-size)",
          fontWeight: "var(--font-weight-semibold)",
          marginTop: "32px",
          marginBottom: "24px",
        }}
      >
        Heading Styles
      </h2>
      {headingSamples.map((s) => (
        <div key={s.label} style={{ marginBottom: "16px" }}>
          <div
            style={{
              fontSize: `var(${s.sizeVar})`,
              fontWeight: `var(--font-weight-${s.weight})`,
            }}
          >
            {s.label} — The quick brown fox jumps over the lazy dog
          </div>
          <code
            style={{
              fontSize: "var(--font-text-xs-size)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {s.sizeVar}
          </code>
        </div>
      ))}

      <h2
        style={{
          fontSize: "var(--font-heading-md-size)",
          fontWeight: "var(--font-weight-semibold)",
          marginTop: "32px",
          marginBottom: "24px",
        }}
      >
        Font Weights
      </h2>
      {weightSamples.map((s) => (
        <div key={s.label} style={{ marginBottom: "12px" }}>
          <span
            style={{
              fontSize: "var(--font-text-md-size)",
              fontWeight: `var(${s.var})`,
            }}
          >
            {s.label}
          </span>
          <code
            style={{
              fontSize: "var(--font-text-xs-size)",
              color: "var(--color-text-tertiary)",
              marginLeft: "12px",
            }}
          >
            {s.var}
          </code>
        </div>
      ))}

      <h2
        style={{
          fontSize: "var(--font-heading-md-size)",
          fontWeight: "var(--font-weight-semibold)",
          marginTop: "32px",
          marginBottom: "24px",
        }}
      >
        Monospace
      </h2>
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-text-sm-size)",
        }}
      >
        const value = "font-mono: ui-monospace, monospace";
      </code>
    </div>
  );
}

const meta: Meta = {
  title: "Design System/Typography",
  component: TypographyShowcase,
};

export default meta;
type Story = StoryObj;

export const Light: Story = {};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <div
        className="dark"
        style={{
          background: "var(--color-background-primary)",
          padding: "24px",
          borderRadius: "8px",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
