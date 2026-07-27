import {
  assertDarkOverridesAreKnown,
  assertDarkRulesAgree,
  DESIGN_TOKENS,
  isColorValue,
  TOKEN_GROUPS,
} from "@gaggiuino/design-system/tokens";
import { type Meta, type StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import "../src/tokens.css";

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-border-tertiary)",
  fontSize: "var(--font-text-xs-size)",
  verticalAlign: "middle",
};

function Value({ value }: { value: string | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
      {value && isColorValue(value) ? (
        <span
          style={{
            display: "inline-block",
            width: 14,
            height: 14,
            borderRadius: 2,
            backgroundColor: value,
            border: "1px solid var(--color-border-secondary)",
          }}
        />
      ) : null}
      <code>{value ?? "—"}</code>
    </span>
  );
}

/**
 * Every row is read out of `tokens.css` at build time, so this table cannot
 * drift from the values that ship.
 */
function TokenTable() {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        padding: "24px",
        color: "var(--color-text-primary)",
      }}
    >
      {TOKEN_GROUPS.map(({ group, tokens }) => (
        <div key={group} style={{ marginBottom: "32px" }}>
          <h3
            style={{
              fontSize: "var(--font-heading-sm-size)",
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "12px",
            }}
          >
            {group}
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
              {tokens.map((token) => (
                <tr key={token.name}>
                  <td style={cellStyle}>
                    <code>{token.name}</code>
                  </td>
                  <td style={cellStyle}>
                    <Value value={token.light} />
                  </td>
                  <td style={cellStyle}>
                    <Value value={token.dark} />
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

export const AllTokens: Story = {
  play: async ({ canvasElement }) => {
    // The dark block and its prefers-color-scheme fallback are hand-duplicated
    // in the stylesheet; this is the gate that keeps them in step.
    assertDarkRulesAgree();
    assertDarkOverridesAreKnown();

    const canvas = within(canvasElement);
    expect(DESIGN_TOKENS.length).toBeGreaterThan(0);
    for (const token of DESIGN_TOKENS) {
      expect(canvas.getByText(token.name)).toBeInTheDocument();
    }
  },
};
