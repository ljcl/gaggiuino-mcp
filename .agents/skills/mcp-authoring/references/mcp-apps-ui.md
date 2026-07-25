# MCP Apps: UI Surfaces

An MCP app pairs a tool with an HTML UI resource that the host renders alongside the conversation. Use one when seeing beats reading: tabular data, charts, interactive lists, and image galleries all benefit from a visual surface that text cannot match.

## The model: tool + resource + link

- Three parts: (1) a tool the model calls that returns data; (2) a UI resource (bundled HTML/JS) that renders that data; (3) a link from the tool to the resource via `_meta.ui.resourceUri`.
- Flow: the host calls the tool, the server returns a result, the host renders the linked UI resource, and the UI receives the tool result as its input.
- With the `@modelcontextprotocol/ext-apps` SDK this wiring is handled by `registerAppTool` and `registerAppResource`; the tool registration carries `_meta.ui.resourceUri` pointing at the resource URI. Defer exact signatures and options to that SDK's documentation.

```typescript
// The tool result references the UI resource that should render it:
const toolMeta = {
  // ...title, description, inputSchema...
  _meta: { ui: { resourceUri: "ui://my-app/orders" } },
};
// A separate resource registration serves the bundled HTML at that URI.
```

## When to add a UI (and when not to)

- Add UI for: browsing many items, comparing side-by-side, interactive selection, visual data (charts, maps, images).
- Skip UI for: a single value, a yes/no answer, or anything a sentence conveys better. A UI the user must read past to get an answer is worse than text.

## State ownership

- The UI owns view state: current tab, selected row, filter text, hover. Keep it local (component state); do not round-trip view changes through tool calls.
- The server owns domain data. The UI renders what the tool returned; it does not become a second source of truth.
- Anti-pattern: a `select-item` or `set-filter` tool. That logic belongs in the UI.

## Host integration

- The host drives a lifecycle. Handle: receiving tool input, receiving the tool result, the host context changing (e.g. theme/locale), and teardown. With the ext-apps SDK these correspond to handlers like `ontoolinput`, `ontoolresult`, `onhostcontextchanged`, and `onteardown` (and a `useApp` hook for React).
- Read host style variables (theme colors, fonts) and apply them rather than hardcoding a palette; the app should look native in light and dark hosts. The ext-apps SDK exposes helpers (e.g. `applyHostStyleVariables`, `applyHostFonts`) for this.
- Size to content; let the surface resize as content changes instead of locking a fixed height.

## Keeping the model in sync

- When the user changes what they are looking at (active tab, selected product), the model can become stale. Surface the current view state back to the model via the host's provided mechanism so follow-up turns are about what the user actually sees, without spending extra tool calls.

## UI design guidelines

- Theme: derive every color from host style variables; support light and dark.
- Responsive: use fluid grids/flex; avoid fixed widths that clip in narrow hosts.
- States: always handle loading, empty, and error states explicitly; never render a blank box while data is pending.
- Accessibility: label inputs (`<label htmlFor>`), give icon-only buttons `aria-label`, support keyboard activation (Enter/Space) and visible focus, and add `alt` text to images.
- Typography and spacing: consistent scale; readable body sizes; consistent spacing units.
- Headless primitives: for any non-trivial interactive control (menus, dialogs, popovers, selects, comboboxes, sliders, toggle groups) reach for a headless library — this repo standardizes on [Base UI](https://base-ui.com/) (`@base-ui/react`) — instead of hand-rolling focus management, positioning, dismissal, and roving tabindex. Style the unstyled primitives with CSS Modules and `data-*` selectors (Base UI exposes `data-pressed`, `data-disabled`, etc.). Skip primitives for purely presentational components.

## UI security

- Treat tool output rendered in the UI as untrusted input: sanitize before inserting into the DOM; never `innerHTML` raw model/tool data.
- Respect the host's sandbox; do not try to escape the iframe or reach host internals.
- Never ship secrets in the UI bundle; it runs on the client. Secrets stay on the server. See [auth-and-security.md](auth-and-security.md).

## Checklist

- Tool and resource are linked via `_meta.ui.resourceUri`.
- UI holds only view state; server owns domain data.
- Reads host theme and fonts via ext-apps SDK helpers.
- Handles loading, empty, and error states explicitly.
- Accessible: labels, aria attributes, keyboard support, alt text.
- Sanitizes all injected data; no raw `innerHTML` from tool output.
- No secrets in the UI bundle.
