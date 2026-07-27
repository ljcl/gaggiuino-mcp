import tokensCss from "./tokens.css?raw";

/**
 * `tokens.css` is the single source of truth for token values — it is what
 * ships in the MCP App and what hosts override at runtime. Nothing restates
 * those values in TypeScript; this module parses the stylesheet instead, so
 * the Storybook docs are derived from the same bytes the browser reads.
 */

/** One declaration inside a token rule. */
export interface TokenDeclaration {
  /** Property name, e.g. `--color-text-primary`. */
  name: string;
  /** Declared value, verbatim from the stylesheet. */
  value: string;
  /** Nearest preceding standalone comment, used as the docs section heading. */
  group: string;
}

/** One style rule from `tokens.css`. */
export interface TokenRule {
  /** Selector text, e.g. `:root` or `[data-theme="dark"]`. */
  selector: string;
  /** Enclosing at-rule prelude, when the rule sits inside one. */
  atRule: string | null;
  declarations: TokenDeclaration[];
}

/** A token as the docs present it: its light value and its dark override. */
export interface DesignToken {
  name: string;
  group: string;
  light: string;
  /** `null` when the token has no dark override. */
  dark: string | null;
}

/** Read the balanced `{ … }` block whose opening brace is at `open`. */
function readBlock(css: string, open: number): { body: string; next: number } {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return { body: css.slice(open + 1, i), next: i + 1 };
    }
  }
  throw new Error("tokens.css: unbalanced block");
}

function parseDeclarations(body: string): TokenDeclaration[] {
  const declarations: TokenDeclaration[] = [];
  let group = "";
  let buffer = "";

  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    declarations.push({
      name: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
      group,
    });
  };

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      const stop = end === -1 ? body.length : end;
      // Only a comment between declarations names a section; a trailing
      // comment on a declaration line must not retitle the next one.
      if (buffer.trim() === "") group = body.slice(i + 2, stop).trim();
      i = stop + 1;
      continue;
    }
    if (body[i] === ";") {
      flush();
      continue;
    }
    buffer += body[i];
  }
  flush();

  return declarations;
}

/** Parse the style rules out of a stylesheet, one level of at-rule nesting deep. */
export function parseTokenRules(
  css: string,
  atRule: string | null = null,
): TokenRule[] {
  const rules: TokenRule[] = [];
  let prelude = "";

  for (let i = 0; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (css[i] === ";") {
      // A statement at-rule such as `@import "…";` — not a block.
      prelude = "";
      continue;
    }
    if (css[i] === "{") {
      const { body, next } = readBlock(css, i);
      const selector = prelude.trim();
      if (selector.startsWith("@")) {
        rules.push(...parseTokenRules(body, selector));
      } else {
        rules.push({ selector, atRule, declarations: parseDeclarations(body) });
      }
      prelude = "";
      i = next - 1;
      continue;
    }
    prelude += css[i];
  }

  return rules;
}

/** Every style rule in `tokens.css`, in source order. */
export const TOKEN_RULES: TokenRule[] = parseTokenRules(tokensCss);

/** The unconditional `:root` rule — the light defaults every token starts from. */
export const BASE_RULE: TokenRule = (() => {
  const base = TOKEN_RULES.find(
    (r) => r.selector === ":root" && r.atRule === null,
  );
  if (!base) throw new Error("tokens.css: no unconditional :root rule");
  return base;
})();

/**
 * Every rule that overrides the base for dark mode: the `[data-theme="dark"]`
 * rule the host activates, plus the `prefers-color-scheme` fallback. They are
 * required to be identical — {@link assertDarkRulesAgree} checks that.
 */
export const DARK_RULES: TokenRule[] = TOKEN_RULES.filter(
  (r) => r !== BASE_RULE,
);

/** Declarations of a rule as a name → value map. */
export function declarationMap(rule: TokenRule): Record<string, string> {
  return Object.fromEntries(rule.declarations.map((d) => [d.name, d.value]));
}

/**
 * The dark rules are hand-duplicated (CSS cannot share one block between a
 * selector and a media query), so drift between them is the failure mode this
 * guards. Throws with the offending token named.
 */
export function assertDarkRulesAgree(rules: TokenRule[] = DARK_RULES): void {
  const [first, ...rest] = rules;
  if (!first) throw new Error("tokens.css: no dark override rule");
  const expected = declarationMap(first);
  const label = (r: TokenRule) =>
    r.atRule ? `${r.atRule} { ${r.selector} }` : r.selector;

  for (const rule of rest) {
    const actual = declarationMap(rule);
    for (const name of new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ])) {
      if (expected[name] !== actual[name]) {
        throw new Error(
          `tokens.css: ${name} is "${expected[name] ?? "(absent)"}" in ${label(first)} ` +
            `but "${actual[name] ?? "(absent)"}" in ${label(rule)}`,
        );
      }
    }
  }
}

/**
 * Every dark override must correspond to a base token; a name that exists only
 * in a dark rule is a typo that silently never applies in light mode.
 */
export function assertDarkOverridesAreKnown(): void {
  const base = declarationMap(BASE_RULE);
  for (const rule of DARK_RULES) {
    for (const { name } of rule.declarations) {
      if (name.startsWith("--") && !(name in base)) {
        throw new Error(
          `tokens.css: ${name} is overridden for dark but never declared in :root`,
        );
      }
    }
  }
}

/** Custom properties only — `color-scheme` and friends are not tokens. */
function customProperties(rule: TokenRule): TokenDeclaration[] {
  return rule.declarations.filter((d) => d.name.startsWith("--"));
}

/** Every token, with its light value and dark override, in stylesheet order. */
export const DESIGN_TOKENS: DesignToken[] = (() => {
  const dark = DARK_RULES[0] ? declarationMap(DARK_RULES[0]) : {};
  return customProperties(BASE_RULE).map(({ name, value, group }) => ({
    name,
    group,
    light: value,
    dark: dark[name] ?? null,
  }));
})();

/** {@link DESIGN_TOKENS} bucketed by the section comments in the stylesheet. */
export const TOKEN_GROUPS: { group: string; tokens: DesignToken[] }[] = (() => {
  const groups: { group: string; tokens: DesignToken[] }[] = [];
  for (const token of DESIGN_TOKENS) {
    const last = groups.at(-1);
    if (last?.group === token.group) last.tokens.push(token);
    else groups.push({ group: token.group, tokens: [token] });
  }
  return groups;
})();

/** True for values a swatch can render. */
export function isColorValue(value: string): boolean {
  return (
    value.startsWith("#") || value.startsWith("rgb") || value.startsWith("hsl")
  );
}
