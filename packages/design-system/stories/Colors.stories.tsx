import {
  DESIGN_TOKENS,
  isColorValue,
  TOKEN_GROUPS,
} from "@gaggiuino/design-system/tokens";
import { type Meta, type StoryObj } from "@storybook/react";
import { expect } from "storybook/test";
import "../src/tokens.css";

/** Only the groups whose values are colors — typography and radii have no swatch. */
const colorGroups = TOKEN_GROUPS.map(({ group, tokens }) => ({
  group,
  tokens: tokens.filter(
    (t) => t.name.startsWith("--color-") || t.name.startsWith("--chart-"),
  ),
})).filter(({ tokens }) => tokens.length > 0);

/** `--color-background-primary` → `Background primary`. */
function label(name: string): string {
  const words = name.replace(/^--(color|chart)-/, "").split("-");
  return words.join(" ").replace(/^./, (c) => c.toUpperCase());
}

function Swatch({ variable, name }: { variable: string; name: string }) {
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
          {name}
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
      {colorGroups.map(({ group, tokens }) => (
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
              <Swatch key={t.name} variable={t.name} name={label(t.name)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Assert the browser resolves every token to the value the stylesheet declares
 * for `theme`. This is what catches a dark palette keyed on a selector nothing
 * applies.
 */
function expectResolvedTheme(theme: "light" | "dark") {
  const computed = getComputedStyle(document.documentElement);
  expect(document.documentElement.dataset.theme).toBe(theme);

  // A CSS minifier may rewrite `rgba(222, 220, 209, 0.4)` to `#dedcd166`, so
  // compare colors by what the browser parses them to, not by source text.
  const probe = document.createElement("div");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const asColor = (value: string) => {
    probe.style.backgroundColor = "";
    probe.style.backgroundColor = value;
    return getComputedStyle(probe).backgroundColor;
  };

  try {
    for (const token of DESIGN_TOKENS) {
      if (theme === "dark" && token.dark === null) continue;
      const declared = (theme === "dark" ? token.dark : token.light) as string;
      const resolved = computed.getPropertyValue(token.name).trim();
      const [expected, actual] = isColorValue(declared)
        ? [asColor(declared), asColor(resolved)]
        : [declared, resolved];
      // An unparseable color canonicalises to transparent on both sides, which
      // would compare equal and hide the failure this story exists to catch.
      if (isColorValue(declared)) expect(expected).not.toBe("rgba(0, 0, 0, 0)");
      expect(`${token.name}: ${actual}`).toBe(`${token.name}: ${expected}`);
    }
  } finally {
    probe.remove();
  }
}

const meta: Meta = {
  title: "Design System/Colors",
  component: ColorGrid,
};

export default meta;
type Story = StoryObj;

export const Light: Story = {
  globals: { backgrounds: { value: "light" } },
  play: () => expectResolvedTheme("light"),
};

export const Dark: Story = {
  globals: { backgrounds: { value: "dark" } },
  play: () => expectResolvedTheme("dark"),
};
