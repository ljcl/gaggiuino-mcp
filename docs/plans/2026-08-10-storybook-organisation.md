# Organising the design system and stories in Storybook — Research

**Date:** 2026-08-10
**Status:** Research complete. Recommendations ranked; nothing implemented yet.

## The question

What is the most effective way to organise this repo's design system and its
stories in Storybook, against modern (Storybook 9/10-era) best practice?
Storybook is this repo's primary surface for **human review** of mostly
AI-authored UI work, and doubles as its documentation and its browser-resolved
test harness — so "organisation" here means the sidebar a reviewer navigates,
the docs a reader lands on, and the conventions story authors follow, without
disturbing the test gates the stories carry.

## Where the current setup already matches best practice

Most of the 2025/26 guidance describes what this repo already does. Worth
stating plainly so nobody "fixes" these toward an older pattern:

- **A dedicated Storybook workspace globbing co-located stories** is the
  recommended monorepo shape, verbatim. Storybook's own docs say story files
  should live next to the component they document, and the Turborepo community
  guidance warns against embedding Storybook inside a UI library package —
  `apps/storybook` + `packages/*/src/*.stories.tsx` is exactly the sanctioned
  layout. (Storybook first-class monorepo support is still an open RFC,
  storybookjs/storybook#22521; the dedicated-app pattern is the answer until
  then.)
- **`titlePrefix` per glob entry** is the documented way to give each package
  its own sidebar root without writing `title` in every file — what `main.ts`
  does for `Shot Graph` and `UI`.
- **The testing stack is the officially recommended one**: `@storybook/addon-vitest`
  rendering every story in real Chromium (render = smoke test, `play` =
  interaction test), with addon-a11y wired in. Our project-wide
  `a11y: { test: "error" }` is the *strict* end of official guidance — the
  addon's own default is `"todo"` (record and pass) — and strictness is the
  right call for a codebase with no legacy stories to burn down.
- **Token docs parsed from the token source** is ahead of most published
  examples, not behind them. The community consensus is that token
  documentation must be generated from the artifact the code consumes, never
  hand-restated; `tokens.ts` parsing `tokens.css` via `?raw` satisfies that,
  and the play-function gates additionally assert what the *browser* resolves,
  which no documentation-only approach does. The dedicated token addons
  (storybook-design-token and its forks) are fragmented and lag Storybook
  majors — first-party support is a long-open discussion
  (storybookjs/storybook#23088) with nothing shipped as of SB10. Do not adopt
  one.
- **CSF3 conventions**: typed `Meta`/`StoryObj`, one named export per
  meaningful state, behaviour-descriptive names (`MachineUnreachable`,
  `ComparisonOutlastsPrimary`), shared inputs via args — all current guidance.
- **"If it renders, it belongs in a story"** (AGENTS.md's rule against jsdom
  component harnesses) is Storybook's own stated position: real-browser story
  tests obsolete jsdom component tests.

## What the research says, where we diverge

### 1. Sidebar hierarchy: purpose-named roots, docs first, no Atomic Design

Official guidance (the "Structuring your Storybook" guide) recommends a small
set of top-level roots with documentation pages sorted **before** component
stories: an Intro/Getting-started section, a Foundations/Tokens section, then
components. Mature systems converge on **Foundations / Components / Patterns**
top levels (WordPress's 2024 design-system restructure adopted exactly that
set).

**Atomic Design as sidebar taxonomy is no longer a default recommendation.**
It survives in Storybook's guide as one of three named options (alongside
functionality-based and status-based grouping), but practitioner consensus has
moved on: teams waste energy debating whether something is a molecule or an
organism, and users look for components by *purpose*, not abstraction level.
Even Brad Frost frames it as optional vocabulary. With ~11 components across
three packages, adopting it here would add a classification argument and
nothing else. **Deliberately not adopting.**

For this repo, the honest taxonomy already exists: the package boundaries that
`turbo boundaries` enforces (`design-system` at the bottom, `shared-ui` above
it, `mcp-app` on top). The current roots — `Design System`, `UI`,
`Shot Graph` — mirror that layering exactly. The divergence from best practice
is not the grouping; it is that **nothing orders it**.

### 2. Ordering falls out of glob order, and it reads backwards

With no `storySort`, the sidebar renders in story-index order, which is
`main.ts` glob order: Shot Graph first, then UI, then design-system — so
`Introduction`, the orientation page, renders **last**, and the tree reads
top-down (app → shell → tokens) when a reviewer orients bottom-up
(tokens → shell → app). The official fix is one block in `preview.tsx`:

```ts
options: {
  storySort: {
    order: ["Introduction", "Design System", "UI", "Shot Graph"],
  },
},
```

This is the cheapest genuine win available. It changes no story ids, no
titles, no test names — purely presentation.

### 3. Autotitle vs explicit titles: bless the current mix as the convention

Official guidance: prefer autotitle when the directory structure *is* the
information architecture; use explicit `title` when the sidebar must diverge
from the file layout. The repo currently uses both — autotitle + `titlePrefix`
for the two component packages, explicit `Design System/...` titles for the
docs-style stories (where `Tokens.stories.tsx` deliberately reads as
"Token Reference", not "Tokens").

That mix is coherent, and normalising it in either direction costs more than
it returns, because **story ids are derived from titles** and this repo's ids
are load-bearing in the same way its tool contract is:

- `bun run shots <id>` addresses stories by id;
- the published Pages Storybook has per-story URLs people may have bookmarked;
- `test:stories` test names embed the title path.

A title rename is the story-id analogue of re-keying a permission grant:
nobody does it by accident, so make it a deliberate edit with the cost named.
**Convention to record:** component stories use autotitle under the glob's
`titlePrefix`; curated docs-style stories may set an explicit title; renames
are breaking changes to the published Storybook's URLs.

One wart worth knowing about rather than fixing: `titlePrefix` applies to
*explicit* titles too (ChartAccessibility.stories.tsx documents this — its
`title: "Chart accessibility"` lands under `Shot Graph/`). That is why the
design-system glob carries no `titlePrefix`: adding one would relocate
`Introduction` (an MDX page with `<Meta title="Introduction" />` in that glob)
under `Design System/Introduction`.

### 4. Docs strategy: autodocs is the baseline; grow MDX only where prose earns it

Project-wide `tags: ["autodocs"]` matches guidance. The official pattern for a
design system adds **unattached MDX pages** — Getting Started, contribution
conventions, token/foundations pages — pinned first by `storySort`.

This repo has one (`Introduction.mdx`) and it is thin. Given the stated
mission — Storybook as the human-review surface for AI-authored work — the one
page genuinely worth adding is a **"How to review" page**: what the Host Theme
toolbar simulates and why (it mirrors `useHostStyles`), what the
`Claude iOS Card` viewport is for, which stories are CI gates and what they
enforce (`a11y: error`, the Chart accessibility contrast/CVD contract, the
token-resolution gates), and what a reviewer should actually look at before
approving a UI change. That context currently lives only in AGENTS.md, which a
human reviewer browsing the deployed Pages Storybook never sees.

**Do not convert the token/colour/typography stories to MDX doc-block pages**
(`ColorPalette`, `Typeset` et al.), tempting as the official blocks look. MDX
pages do not run `play` functions, and those stories are the regression tests
for the dead-dark-selector class of bug — the assertion that the browser
resolves each token to the value the stylesheet declares. The hand-rolled
tables render from parsed source *and* assert; the doc blocks only render.

### 5. Tags: the modern mechanism, but nothing here needs one yet

SB9 shipped tag-based organisation (badges, sidebar filtering; SB10 added
exclusion filters and `defaultFilterSelection`). Guidance now says status
taxonomy (`experimental` / `deprecated` / `stable`) belongs in tags, not title
prefixes, and `!dev` hides fixture-only stories from the sidebar while keeping
them in test runs.

At the current scale — 14 story files, every story doubling as a review
surface — there is nothing to filter and nothing worth hiding. Several stories
are pure behaviour gates (`ControlledVisibility`, `ReportsVisibilityChanges`,
`TogglesReportPressedState`, `RetrySucceeds`) and *could* take `!dev`, but the
repo's posture is that visible gates are a feature: the Chart accessibility
story exists partly so a human can review the simulated CVD swatches. Hiding
gates contradicts the review mission. **Adopt tags when a trigger arrives** —
a second MCP app, a deprecation, or a sidebar big enough that filtering beats
scrolling — not before.

### 6. What changed in SB9/10 that this repo should track, not chase

- **CSF factories ("CSF Next")** — `preview.meta({...})` / `meta.story({...})`
  replacing the `Meta`/`StoryObj` typing idiom — were promoted to *preview* in
  SB10. Not stable. The migration is mechanical and codemod-assisted when it
  lands; adopting during preview buys type-checked project tags at the story
  site and pays API-churn risk. **Wait for stable.**
- **ESM-only distribution** (SB10): already satisfied — the repo is ESM
  throughout and on 10.5.7.
- The old `@storybook/test-runner` and portable-stories-by-hand are legacy
  paths this repo never took; nothing to do.
- One monorepo gotcha to keep in the back pocket: if autodocs prop tables ever
  come up empty for components imported across package boundaries, the
  documented fix is `reactDocgenTypescriptOptions.include` listing the other
  packages' sources in `main.ts`. Not currently a problem — each package's
  stories are discovered from that package's own directory.

## Recommendations, ranked

**Adopt now (small, id-stable, serves the review mission):**

1. **Add `options.storySort.order`** to `preview.tsx`:
   `["Introduction", "Design System", "UI", "Shot Graph"]` — orientation page
   first, then bottom-up in boundary-layer order. No ids move.
2. **Write the "How to review" MDX page** (unattached, pinned after
   Introduction — or grow Introduction into it). Content: the Host Theme
   toolbar's contract with `useHostStyles`, the viewport presets, which
   stories are CI gates and what each enforces, what to eyeball before
   approving. This is the highest-leverage docs work available because it
   serves the repo's actual Storybook constituency: a human reviewing AI
   output.
3. **Record the title convention** (autotitle + `titlePrefix` for component
   packages; explicit titles for curated docs stories; title renames are
   breaking changes to published story URLs) in AGENTS.md's Storybook section,
   so an agent adding a story matches the pattern instead of inventing one.

**Adopt when triggered, not before:**

4. Status/custom tags and sidebar filtering — trigger: a deprecation, an
   experimental component, or a second app's stories landing.
5. `!dev` on behaviour-gate stories — trigger: sidebar scale making clutter
   real, and only for stories with no visual-review value.
6. `reactDocgenTypescriptOptions.include` — trigger: an empty prop table on a
   cross-package component.

**Deliberately not adopting (record the reason, close the question):**

7. **Atomic Design sidebar taxonomy** — consensus moved on; package-boundary
   roots are this repo's honest structure.
8. **Design-token addons** — fragmented, lag Storybook majors; the
   parse-from-source + browser-assertion approach is stronger than any of
   them.
9. **Converting token stories to MDX doc-block pages** — loses the `play`
   gates; the stories are tests first.
10. **CSF factories migration** — preview status; revisit at stable.
11. **Storybook Composition** — for multi-team orgs with independently
    deployed Storybooks; one team, one Storybook.
12. **Visual-regression gate (Chromatic etc.)** — already a recorded decision
    (AGENTS.md: deliberately no pixel-level gate; `bun run shots` covers
    look-at-it review).

## Costs and invariants any implementation must respect

- **Story ids are a public surface** (Pages URLs, `bun run shots`, test
  names). `storySort` and new MDX pages do not touch them; title or export
  renames do.
- **The design-system stories are CI gates, not just docs.** Any restructure
  must keep them as CSF stories with `play` functions, discovered by the
  `test:stories` glob.
- **The preview decorator's canvas painting and host-theme mirroring** are
  load-bearing for the a11y gate (AGENTS.md records the 1.05:1 contrast
  failure mode). New docs pages render under the same decorator; a docs page
  that fights the painted background will fail axe, correctly.
- **`Introduction.mdx` lives in the unprefixed glob on purpose** — moving it
  into a prefixed glob relocates it in the sidebar (see §3).

## Sources

Official: [Structuring your Storybook](https://storybook.js.org/blog/structuring-your-storybook/) ·
[Naming components and hierarchy](https://storybook.js.org/docs/writing-stories/naming-components-and-hierarchy) ·
[Sidebar and URLs](https://storybook.js.org/docs/configure/user-interface/sidebar-and-urls) ·
[main.js stories config](https://storybook.js.org/docs/api/main-config/main-config-stories) ·
[Autodocs](https://storybook.js.org/docs/writing-docs/autodocs) ·
[MDX](https://storybook.js.org/docs/writing-docs/mdx) ·
[Tags](https://storybook.js.org/docs/writing-stories/tags) ·
[Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon) ·
[Accessibility testing](https://storybook.js.org/docs/writing-tests/accessibility-testing) ·
[Storybook 9](https://storybook.js.org/blog/storybook-9/) ·
[Storybook 10](https://storybook.js.org/blog/storybook-10/) ·
[CSF Next](https://storybook.js.org/docs/api/csf/csf-next)

Community: [Brad Frost — Atomic Design and Storybook](https://bradfrost.com/blog/post/atomic-design-and-storybook/) ·
[Atomic Design in Practice (2025)](https://www.mykolaaleksandrov.dev/posts/2025/11/atomic-design-in-practice/) ·
[WordPress Design Systems: Storybook Improvements](https://make.wordpress.org/design/2024/09/17/design-systems-storybook-improvements/) ·
[Using Storybook in a Monorepo](https://kamranicus.com/using-storybook-in-a-monorepo/) ·
[Turborepo discussion #6879](https://github.com/vercel/turborepo/discussions/6879) ·
[Storybook monorepo RFC #22521](https://github.com/storybookjs/storybook/discussions/22521) ·
[Design-token support discussion #23088](https://github.com/storybookjs/storybook/discussions/23088)
