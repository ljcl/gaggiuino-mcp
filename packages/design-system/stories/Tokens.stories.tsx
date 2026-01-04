import type { Meta, StoryObj } from "@storybook/react";
import "../src/tokens.css";

const allTokens = [
  {
    category: "Background",
    tokens: [
      { var: "--color-background-primary", light: "#ffffff", dark: "#30302e" },
      {
        var: "--color-background-secondary",
        light: "#f5f4ed",
        dark: "#262624",
      },
      { var: "--color-background-tertiary", light: "#faf9f5", dark: "#141413" },
      { var: "--color-background-inverse", light: "#141413", dark: "#faf9f5" },
    ],
  },
  {
    category: "Text",
    tokens: [
      { var: "--color-text-primary", light: "#14141a", dark: "#faf9f5" },
      { var: "--color-text-secondary", light: "#3d3d3a", dark: "#c2c0b6" },
      { var: "--color-text-tertiary", light: "#73726c", dark: "#9c9a92" },
      { var: "--color-text-danger", light: "#7f2c28", dark: "#ee8884" },
      { var: "--color-text-success", light: "#275b19", dark: "#7ab948" },
      { var: "--color-text-info", light: "#3266ad", dark: "#80aadd" },
    ],
  },
  {
    category: "Border",
    tokens: [
      {
        var: "--color-border-primary",
        light: "rgba(31,30,29,0.40)",
        dark: "rgba(222,220,209,0.40)",
      },
      {
        var: "--color-border-secondary",
        light: "rgba(31,30,29,0.30)",
        dark: "rgba(222,220,209,0.30)",
      },
      {
        var: "--color-border-tertiary",
        light: "rgba(31,30,29,0.15)",
        dark: "rgba(222,220,209,0.15)",
      },
    ],
  },
  {
    category: "Typography",
    tokens: [
      {
        var: "--font-sans",
        light: "system-ui, -apple-system, sans-serif",
        dark: "—",
      },
      { var: "--font-mono", light: "ui-monospace, monospace", dark: "—" },
      { var: "--font-weight-normal", light: "400", dark: "—" },
      { var: "--font-weight-medium", light: "500", dark: "—" },
      { var: "--font-weight-semibold", light: "600", dark: "—" },
      { var: "--font-weight-bold", light: "700", dark: "—" },
      { var: "--font-text-xs-size", light: "12px", dark: "—" },
      { var: "--font-text-sm-size", light: "14px", dark: "—" },
      { var: "--font-text-md-size", light: "16px", dark: "—" },
      { var: "--font-heading-sm-size", light: "16px", dark: "—" },
      { var: "--font-heading-md-size", light: "20px", dark: "—" },
    ],
  },
  {
    category: "Border Radius",
    tokens: [
      { var: "--border-radius-xs", light: "2px", dark: "—" },
      { var: "--border-radius-sm", light: "4px", dark: "—" },
      { var: "--border-radius-md", light: "8px", dark: "—" },
      { var: "--border-radius-lg", light: "12px", dark: "—" },
      { var: "--border-width-regular", light: "1px", dark: "—" },
    ],
  },
  {
    category: "Chart",
    tokens: [
      { var: "--chart-pressure", light: "#2ca02c", dark: "—" },
      { var: "--chart-flow", light: "#1f77b4", dark: "—" },
      { var: "--chart-weight-flow", light: "#b5832a", dark: "—" },
      { var: "--chart-weight", light: "rgba(107,66,38,0.5)", dark: "—" },
    ],
  },
];

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-border-tertiary)",
  fontSize: "var(--font-text-xs-size)",
  verticalAlign: "middle",
};

function TokenTable() {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        padding: "24px",
        color: "var(--color-text-primary)",
      }}
    >
      {allTokens.map(({ category, tokens }) => (
        <div key={category} style={{ marginBottom: "32px" }}>
          <h3
            style={{
              fontSize: "var(--font-heading-sm-size)",
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "12px",
            }}
          >
            {category}
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  color: "var(--color-text-tertiary)",
                }}
              >
                <th style={cellStyle}>Variable</th>
                <th style={cellStyle}>Light</th>
                <th style={cellStyle}>Dark</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.var}>
                  <td style={cellStyle}>
                    <code>{t.var}</code>
                  </td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {t.light.startsWith("#") || t.light.startsWith("rgb") ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 14,
                            height: 14,
                            borderRadius: 2,
                            backgroundColor: t.light,
                            border: "1px solid var(--color-border-secondary)",
                          }}
                        />
                      ) : null}
                      <code>{t.light}</code>
                    </span>
                  </td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {t.dark.startsWith("#") || t.dark.startsWith("rgb") ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 14,
                            height: 14,
                            borderRadius: 2,
                            backgroundColor: t.dark,
                            border: "1px solid var(--color-border-secondary)",
                          }}
                        />
                      ) : null}
                      <code>{t.dark}</code>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

const meta: Meta = {
  title: "Design System/Token Reference",
  component: TokenTable,
};

export default meta;
type Story = StoryObj;

export const AllTokens: Story = {};
