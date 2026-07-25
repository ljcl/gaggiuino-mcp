import { type Meta, type StoryObj } from "@storybook/react";
import "../src/tokens.css";

const colorTokens = {
  Background: [
    { var: "--color-background-primary", label: "Primary" },
    { var: "--color-background-secondary", label: "Secondary" },
    { var: "--color-background-tertiary", label: "Tertiary" },
    { var: "--color-background-inverse", label: "Inverse" },
  ],
  Text: [
    { var: "--color-text-primary", label: "Primary" },
    { var: "--color-text-secondary", label: "Secondary" },
    { var: "--color-text-tertiary", label: "Tertiary" },
    { var: "--color-text-danger", label: "Danger" },
    { var: "--color-text-success", label: "Success" },
    { var: "--color-text-info", label: "Info" },
  ],
  Border: [
    { var: "--color-border-primary", label: "Primary" },
    { var: "--color-border-secondary", label: "Secondary" },
    { var: "--color-border-tertiary", label: "Tertiary" },
  ],
  Chart: [
    { var: "--chart-pressure", label: "Pressure" },
    { var: "--chart-flow", label: "Flow" },
    { var: "--chart-weight-flow", label: "Weight Flow" },
    { var: "--chart-weight", label: "Weight" },
  ],
};

function Swatch({ variable, label }: { variable: string; label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "8px",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: "var(--border-radius-sm)",
          backgroundColor: `var(${variable})`,
          border: "1px solid var(--color-border-secondary)",
          flexShrink: 0,
        }}
      />
      <div>
        <div
          style={{
            fontSize: "var(--font-text-sm-size)",
            color: "var(--color-text-primary)",
          }}
        >
          {label}
        </div>
        <code
          style={{
            fontSize: "var(--font-text-xs-size)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {variable}
        </code>
      </div>
    </div>
  );
}

function ColorGrid() {
  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: "24px" }}>
      {Object.entries(colorTokens).map(([group, tokens]) => (
        <div key={group} style={{ marginBottom: "32px" }}>
          <h3
            style={{
              fontSize: "var(--font-heading-sm-size)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--color-text-primary)",
              marginBottom: "16px",
            }}
          >
            {group}
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "8px",
            }}
          >
            {tokens.map((t) => (
              <Swatch key={t.var} variable={t.var} label={t.label} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const meta: Meta = {
  title: "Design System/Colors",
  component: ColorGrid,
};

export default meta;
type Story = StoryObj;

export const Light: Story = {
  globals: { backgrounds: { value: "light" } },
};

export const Dark: Story = {
  globals: { backgrounds: { value: "dark" } },
};
