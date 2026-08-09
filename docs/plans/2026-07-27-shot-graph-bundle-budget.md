# Shot-graph bundle budget, and whether a lighter chart library is worth it

Closes the third acceptance criterion of #38 ("follow-up decision recorded on
whether a lighter chart lib is worth it"). The budget guard itself ships in
`scripts/bundle-size.ts`.

## What the bundle weighs

Measured 2026-07-27 on `packages/shot-graph/dist/app.html` at recharts 3.10.1,
`@modelcontextprotocol/ext-apps` 1.7.5, React 19.2.8:

| | Raw | Gzip |
| --- | --- | --- |
| `app.html` (single file, everything inlined) | 1,047,652 B | 279,233 B |

The weight is dependencies, not build settings — the app already builds
production React, minified, with tree-shaken named recharts imports.

(That headline is the figure the decision below was made on, and it is no longer
current — see **Re-measured 2026-08-09**.)

To find out where it goes, three throwaway entry points were bundled in
isolation (`bun build --minify --define process.env.NODE_ENV="production"`),
each importing exactly what the app imports:

| Isolated entry | Raw | Gzip |
| --- | --- | --- |
| `react` + `react-dom/client` | 185,336 B | 59,010 B |
| the 10 recharts components `ShotGraph.tsx` uses (incl. React) | 432,699 B | 127,192 B |
| `@modelcontextprotocol/ext-apps/react` (incl. React) | 429,982 B | 103,283 B |

Subtracting the shared React floor gives a rough split:

- **recharts — ~247 KB raw / ~68 KB gzip.** It drags `@reduxjs/toolkit`,
  `react-redux`, `reselect`, `immer`, `es-toolkit`, `victory-vendor` (the d3
  scale/shape family), `decimal.js-light` and `eventemitter3`.
- **ext-apps and the MCP SDK — ~245 KB raw / ~44 KB gzip**, and it pulls **zod**
  in at runtime. The app's only direct SDK import is `import { type
  CallToolResult }`, a type-only import that erases at build time; zod arrives
  underneath `@modelcontextprotocol/ext-apps/react`, not from anything this repo
  writes.
- **React itself — ~185 KB raw / ~59 KB gzip.** Not negotiable.

Treat the isolated figures as order-of-magnitude: they come from bun's bundler
rather than the vite/rollup pipeline that builds the real artifact, and
single-file inlining inflates the raw total further. The ranking is what matters
and the ranking is stable.

## Re-measured 2026-08-09

| | Raw | Gzip |
| --- | --- | --- |
| `app.html`, before the pressure-against-flow view | 984,769 B | 262,059 B |
| `app.html`, with it | 988,997 B | 263,225 B |

Still recharts 3.10.1, so the ~63 kB the bundle lost since July came from
dependency patches under it and not from anything decided here. The split above
is left as measured on the day rather than restated, because it is what the
decision was made on; what changed is the headline, and the guard's comment now
carries the new number.

The **+4,228 B raw / +1,166 B gzip** in the second row is the whole cost of
`PressureFlowPlot.tsx` (#144), which is the argument for it being a `Line` on a
numeric axis rather than a `Scatter`: `ComposedChart`, `Line`, `XAxis` and
`YAxis` are already in the bundle, where adding `Scatter` measured +12.4 kB raw
/ +3.0 kB gzip — three times the entire feature, for a chart type that would
also have discarded the time ordering the plot exists to show.

## Decision: keep recharts, hold the budget

**Not worth it now.** The premise behind "evaluate a lighter chart layer" was
that recharts dominates the bundle. It does not — it is roughly one third of it,
and the MCP transport layer costs about the same. A chart-library swap is a full
rewrite of `ShotGraph.tsx`, `ChartTooltip.tsx`, `ChartLegend.tsx` and
`annotations.tsx` (composed chart, dual axes, reference lines, responsive
container, custom tooltip and legend), and it would buy back at most ~68 KB
gzip while the app still shipped ~44 KB of zod it never calls.

That trade is not worth a rewrite of the only user-facing UI in the project,
especially while the budget has ~10% headroom and nothing is regressing.

## What would change the decision

Revisit if any of these becomes true:

1. **recharts crosses the budget on its own.** `scripts/bundle-size.ts` is the
   tripwire; a breach is a review conversation, not a silent bump.
2. **ext-apps drops its runtime zod dependency.** That removes the largest
   non-chart chunk and makes recharts genuinely dominant, which is the world the
   original issue assumed.
3. **Render latency becomes a real complaint.** The resource body is re-sent on
   every render, so bundle size is a per-render cost, not a one-off download —
   if a host makes that visible, the calculus changes.

Cheaper things to try before a library swap, in order: check whether ext-apps
exposes a slimmer entry point than `/react`; check whether recharts 3.x ships an
ESM-only build that drops `victory-vendor`; and confirm nothing re-introduces a
namespace `import * as` from recharts, which would defeat tree-shaking outright.

## Budget policy

`scripts/bundle-size.ts` asserts both raw and gzip ceilings, set with ~10%
headroom over the measured size — loose enough that dependency patches do not
trip it, tight enough that a new transitive chart or state library does. CI runs
it with `--strict` after explicitly building shot-graph, and prints the table
into the job summary.

Raising a budget is a deliberate one-line diff with a note saying why. That is
the entire mechanism, and it is the point.
