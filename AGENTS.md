# Gaggiuino MCP Server

Remote MCP server for integrating a Gaggiuino espresso machine with AI tools.

## Architecture

- **Runtime**: Bun (TypeScript)
- **Transport**: Streamable HTTP on port 8000 (`/mcp` endpoint)
- **Deployment**: Docker container (any Docker host), exposed via HTTPS tunnel or reverse proxy
- **Monorepo**: Bun workspaces with Turborepo (`apps/*` + `packages/*`)

## Key Directories

- `apps/server/` - MCP server (tools, prompts, resources, client)
- `apps/storybook/` - Standalone Storybook app, serves stories from all packages
- `packages/shot-graph/` - React + Recharts MCP App for interactive shot graphs
- `packages/ui/` - Shared MCP app shell: host plumbing (`src/host/`) plus presentational components (AppShell, ErrorState, ToolbarButton, Legend, Skeleton, Tooltip)
- `packages/design-system/` - Shared design tokens, components, and host theme presets
- `packages/vite-config/` - Shared Vite config helpers for MCP Apps
- `packages/tsconfig/` - Shared TypeScript configurations
- `apps/server/src/data/profiles.yaml` - YAML profile documentation (not machine profiles)
- `apps/server/src/data/prompts.yaml` - System prompt for espresso dial-in guidance
- `apps/server/src/data/*.example-local.yaml` - Templates for user-specific overrides (copy to `*.local.yaml`)
- `docs/plans/` - Design docs and implementation plans

## Agent Skills

Project-scoped Agent Skills are vendored under `.agents/skills/` and surfaced to Claude Code
via symlinks in `.claude/skills/`. Externally-sourced skills are tracked in `skills-lock.json`
(source + content hash); locally-authored skills are not locked.

- `mcp-authoring` — locally-authored, framework-neutral guidance for building and reviewing MCP
  servers and apps (primitives, tool schema design, MCP App UI, testing). Use it when changing
  server tools, resources, or the shot-graph MCP App.
- `backlog-sweep` — locally-authored procedure for re-verifying open GitHub issues against the
  current code and fixing drift. Run it after an epic, breaking change, or wide refactor merges.
- `bun` — Bun runtime, package manager, test runner, and bundler usage (well-known source).
- `github-actions-docs` — docs-grounded help for authoring GitHub Actions workflows (GitHub
  source). `.github/workflows/ci.yml` runs CI on every PR and main push, and the release and
  publish workflows (`release-please.yml`, `docker.yml`, `publish-mcp.yml`, `storybook.yml`)
  are all live — see CI and Releases below.

## MCP Tools

| Tool                   | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `get_status`           | Machine status (temp, pressure, weight)        |
| `get_latest_shot_id`   | Most recent shot ID                            |
| `get_shot_data`        | Structured shot summary (default for analysis) |
| `get_shot_raw_data`    | Complete time-series datapoints                |
| `view_shot_graph`      | Interactive chart (MCP App with UI resource)   |
| `list_profiles`        | Available brew profiles                        |
| `get_profile_info`     | Detailed profile documentation                 |
| `get_dial_in_guidance` | Expert dial-in system prompt                   |

### The tool contract

`apps/server/src/tools.ts` holds one `defineTool(...)` entry per tool: zod input
schema, optional zod output schema, `title`, cold-model `description`,
annotations, and the handler. Nothing about a tool is declared twice.

- **Advertised schemas are generated, never hand-written.** `server.ts`'s
  `toJsonSchema` runs `z.toJSONSchema` over the same schema the dispatcher
  enforces — input schemas in `io: "input"` mode, output schemas in
  `io: "output"` mode. Do not add a literal JSON Schema to a tool.
- **`handleToolCall` is the only dispatch point.** It `safeParse`s the input
  before the handler runs, so handlers receive typed arguments and there are no
  `as string` casts. Invalid input returns an `isError` result naming the field.
- **Output schemas are enforced on the way out.** When a tool declares one, the
  handler's `structured` payload is `.parse()`d before it becomes
  `structuredContent`, so a handler that drifts from its schema fails loudly
  instead of shipping something the host will reject. `get_status`,
  `get_latest_shot_id`, `get_shot_data`, `list_profiles`, and `get_profile_info`
  carry output schemas; the raw/UI/prose tools are text-only by design.
  `get_shot_raw_json` in particular must keep returning a JSON **text** block —
  the shot-graph app parses it with `readToolJson` (`packages/ui/src/host/toolResult.ts`).
- **Annotations are honest, not decorative.** Every tool is
  `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. The
  only axis that varies is `openWorldHint`: true for the tools that reach the
  machine, false for the three that read bundled YAML. A protocol-level test
  asserts this for every tool, so a new tool without annotations fails CI.
- **Expected failures are results, not exceptions.** `errors.ts` defines the
  three upstream failure classes (`UpstreamUnreachableError`,
  `UpstreamHttpError`, `MalformedUpstreamError`) and `describeUpstreamError`
  turns each into text the model can act on — a 404 on a shot points at
  `get_latest_shot_id` by name. Only genuine bugs are allowed to throw.
- **Upstream payloads are validated at the client boundary.** `client.ts`
  parses every machine response with zod. The schemas are deliberately loose
  (unknown keys preserved, only crash-critical fields required) so a firmware
  revision cannot take the server down, but an empty array or a truncated body
  now fails with the offending path named instead of surfacing as
  `Cannot read properties of undefined` several modules later.

`resetClient(config?)` in `client.ts` is a labelled test seam: it drops the
cached client and applies the config to the next one, which is how tests
exercise the retry path without waiting out the real backoff.

### Answer every method the advertised capabilities imply

`createServer()` declares `tools`, `prompts`, and `resources`, and a host
enumerating the server calls **everything** those capabilities cover — including
`resources/templates/list`, which the spec's own resource message-flow puts
directly after `resources/list`. That handler was missing, so the request fell
through to the SDK default and came back `-32601 Method not found`; a host that
treats a JSON-RPC error mid-discovery as a failed discovery abandoned the whole
pass, tools included. This is what made "Refresh tools list" fail in the Claude
connector settings while the already-cached tools kept working.

The rule generalises: adding a capability to `createServer()` means registering
every request handler that capability implies, not only the ones this server has
data for. An empty list is a valid answer; `-32601` is not.

## MCP App (Shot Graph)

https://modelcontextprotocol.io/docs/extensions/apps

The `view_shot_graph` tool renders an interactive Recharts chart in MCP-compatible hosts.

- Uses `@modelcontextprotocol/ext-apps` SDK with React hooks (`useApp`, `useHostStyles`)
- Bundled as single HTML file via `vite-plugin-singlefile` (~1MB)
- Served as MCP resource at `ui://shot-graph/app.html`
- Calls `get_shot_raw_json` (app-only visibility) to fetch data after render
- Supports shot comparison overlay

### The app shell (`packages/ui`)

Host plumbing lives in `packages/ui/src/host/` so a second espresso view (steam
dashboard, shot trends) starts from the shell rather than a copy of `main.tsx`.
`main.tsx` is now composition: parse tool input, fetch, render.

| Module | Responsibility |
| --- | --- |
| `useHostRoot` | `useApp` + `useHostStyles`, tool-input parsing, host-context tracking, mobile/desktop detection |
| `useServerToolData` | Fetch/slow/ready/error/retry state machine over `callServerTool` |
| `useDisplayMode` | `requestDisplayMode`, gated on the host's `availableDisplayModes` |
| `useModelContextSync` | Debounced, deduplicated `updateModelContext` |
| `toolResult.ts` | `readToolJson` / `describeToolError` — the only place a tool result is read |
| `download.ts` | `canDownloadFiles`, `downloadTextFile`, `toCsv` |
| `layoutMode.ts` | Pure mobile-detection signals, unit-tested |

Three rules the shell exists to enforce:

- **Never invent an error message.** `readToolJson` throws `ServerToolError`
  carrying the server's own text, and `describeToolError` passes it through
  untouched. The server writes its diagnostics to be actionable ("the machine
  may be powered off"); replacing them with "Failed to load shot data" throws
  that away.
- **Every host capability is gated before it is offered.** Fullscreen renders
  only when `availableDisplayModes` includes it; export only when the host
  advertises `downloadFile`. A button that silently does nothing is worse than
  no button.
- **Components stay presentational.** `AppShell`, `ErrorState`, and
  `ToolbarButton` take props, not an `App`, so Storybook renders every state
  and the hooks stay the only thing that touches the host.

`useHostRoot` seeds host context from `app.getHostContext()` on connect as well
as from `host-context-changed`. This is load-bearing: hosts send
`availableDisplayModes` in the initialize result and may never send it again,
so an app that only listens for the notification never offers fullscreen.

## Design tokens and theming

`packages/design-system/src/tokens.css` is the **single source of truth** for token
values. Nothing restates them: `src/tokens.ts` parses the stylesheet (`?raw`) into
`DESIGN_TOKENS` / `TOKEN_GROUPS`, and the Colors and Token Reference stories render
from that, so the docs cannot drift from what ships. There is deliberately no
`COLORS`/`CHART_COLORS` constant object — that was a hand-synced third copy and it
is gone. `shot-graph/src/constants.ts` references the tokens as `var(--chart-*)`
strings, which is the one indirection that stays.

Dark mode is keyed on **`[data-theme="dark"]`**, the attribute
`@modelcontextprotocol/ext-apps` sets on `documentElement` (`applyDocumentTheme`,
called by `useHostStyles` with `hostContext.theme`). It is not a `.dark` class —
nothing in the stack applies one, which is why the dark palette used to be dead code
in every real host.

`hostContext.theme` is optional, so a second copy of the dark block lives under
`@media (prefers-color-scheme: dark)` on `:root:not([data-theme="light"])` for hosts
that never send a theme. CSS cannot share one block between a selector and a media
query, so those two blocks are hand-duplicated — `assertDarkRulesAgree()` fails the
Token Reference story if they drift, naming the offending token.

Two gates run as Storybook `play` functions in `bun run test:stories` (design-system
has no unit-test runner by design — see Test coverage below):

- **Token Reference** asserts the dark blocks agree, that every dark override exists
  in `:root`, and that the table renders a row per token.
- **Colors** (`Light` and `Dark`) asserts the *browser* resolves every token to the
  value the stylesheet declares for that theme. This is the regression test for the
  dead-selector bug: point the dark block at anything the host does not set and the
  `Dark` story fails with the computed light value.

The Storybook decorator in `apps/storybook/.storybook/preview.tsx` sets `data-theme`
and `color-scheme` on `documentElement`, mirroring `applyDocumentTheme`. Do not
reintroduce a wrapper element — a hand-applied class makes dark stories pass while
every real host renders light.

## Data Format

Gaggiuino API returns values scaled by 10 (e.g., pressure 91 = 9.1 bar). The `normalize.ts` module handles conversion:
- `SCALE_BY_10`: pressure, pumpFlow, targetPressure, targetPumpFlow, weightFlow, temperature, shotWeight
- Time is in 10ths of seconds (350 = 35.0s)

## Test coverage

Plain `bun run test` no longer computes coverage — it is opt-in via `bun run test:coverage`
(`turbo run test:coverage`), which writes each package's `coverage/coverage-summary.json`.

`apps/server` is the only package with a coverage threshold, defined in `apps/server/vitest.config.ts`
(`coverage.thresholds`, `autoUpdate: true`). Each `bun run test:coverage` run can rewrite those
threshold numbers upward as coverage improves — that is the ratchet working, not drift. If a run
dirties `vitest.config.ts`, commit the new numbers; never hand-edit them.

**One exception, and it will bite you.** Only commit ratcheted numbers measured on a **clean
checkout**. `loader.ts`'s `*.local.yaml` override-merge branches execute only when those files
exist on disk, and they are gitignored — so a dev machine with a local override reports roughly
two points higher than CI can ever reach. Committing those numbers turns `autoUpdate` into a
foot-gun: the thresholds rise above what a clean checkout achieves and every subsequent CI run
fails on `main`. This happened once already (the first CI run on this repo). If you have any
`apps/server/src/data/*.local.yaml`, either move it aside before running `test:coverage`, or take
the numbers from CI rather than locally.

`packages/ui`, `packages/design-system`, and `packages/shot-graph` are **intentionally
unthresholded**. Their coverage is the story render path measured by `bun run
test:stories:coverage` (see Storybook below), not per-package unit coverage. Do not "fix" this by
adding empty test files just to get a `coverage/` directory — there is nothing to threshold there.

Where an assertion lives depends on what it needs, not on which package it is in:

- **Anything a browser has to resolve** goes in a story `play` function so it runs under
  `test:stories`. The token invariants in `packages/design-system` are the case that defines
  the rule — they assert what the *browser* computes for a token, which no headless runner can
  answer. The same goes for component behaviour: the retry loop in `ErrorState` and the
  visibility callback in `ShotGraph` are `play` functions for exactly this reason.
- **Pure functions with no DOM** run under a plain `vitest run`. `packages/ui` and
  `packages/shot-graph` each have one, covering `layoutMode`, `toolResult`, `download`, `csv`,
  and `contextSummary`. This is not a second test runner — it is the same vitest the story
  tests and `apps/server` already use, just without a browser it has no reason to boot.

Neither package has a `test:coverage` script, so neither produces a `coverage/` directory and
the unthresholded rule above still holds. What does *not* belong anywhere is a jsdom harness for
components: if it renders, it belongs in a story.

`packages/design-system` has no `test` script but does have `typecheck`, and its `tsconfig.json`
includes `stories` as well as `src` — the parser in `tokens.ts` and the stories that consume it are
both type-checked in CI.

`bun run coverage:summary` (`scripts/coverage-summary.ts`) globs every `apps/*/coverage/coverage-summary.json`
and `packages/*/coverage/coverage-summary.json`, plus `coverage-stories/coverage-summary.json` when
present, into one markdown table. Packages without a report (no tests, or coverage not run) are
simply absent from the table. It also diffs against a `coverage-baseline/` directory when one
exists. `.github/workflows/ci.yml`'s `check` job restores that baseline from cache before calling
this script and re-saves it after main pushes, so PR job summaries show deltas vs `main`.

## Verification sweep

Run this gate before declaring a task complete or opening a PR.

```bash
bun run check              # lint + test + typecheck + build + knip + boundaries + size (Turborepo)
bun run check:affected     # same, scoped to packages affected by the diff
bun run knip               # Dead code / unused export analysis
bun run test:stories       # Every story renders in headless Chromium (needs Playwright browsers)
docker compose -f docker-compose.yml -f docker-compose.build.yml build   # Image builds from current sources
```

## Commands

```bash
bun install               # Install all deps (workspace-aware)
bun run build             # Build all packages (via Turborepo)
bun run build:affected    # Build only packages affected by the diff
bun run test              # Run all tests (via Turborepo)
bun run test:coverage     # Run tests with coverage (apps/server only has thresholds)
bun run coverage:summary  # Aggregate coverage-summary.json reports into a markdown table
bun run size              # Assert the MCP App bundle size budget (--strict to require the artifact)
bun run test:stories      # Run every Storybook story as a Vitest browser-mode smoke test
bun run test:stories:coverage # Same, plus render-path coverage into coverage-stories/
bun run typecheck         # TS across every workspace package
bun run typecheck:affected # Typecheck only packages affected by the diff
bun run lint               # Biome, repo-wide (NOT `turbo run lint` — infinite loop)
bun run lint:fix           # Biome, applying fixes
bun run boundaries         # turbo boundaries (tag-based layering check)
bun run check              # lint + test + typecheck + build + knip + boundaries + size
bun run check:affected     # same, scoped to packages affected by the diff
bun run dev                # Dev mode (via Turborepo)
bun run storybook          # Storybook on port 6006 (via Turborepo)
bun run build-storybook    # Static Storybook build to apps/storybook/storybook-static/
bun run shots --list       # List story ids
bun run shots <id>...      # Screenshot stories to PNGs under gitignored story-shots/

# Server only
cd apps/server
bun run start        # Start server
bun run dev          # Watch mode
bun run test         # Run server tests

# Rebuild the shot-graph MCP App single-file HTML
cd packages/shot-graph
INPUT=app.html bunx vite build

# Regenerate JSON schemas (after changing Zod schemas in loader.ts)
cd apps/server
bun run generate-schemas

# Docker — default compose pulls ghcr.io/ljcl/gaggiuino-mcp; the override builds from source
docker compose up -d                                                     # published image
docker compose -f docker-compose.yml -f docker-compose.build.yml build   # local build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
docker compose logs -f
```

## Turborepo

A `topo` transit node in `turbo.json` makes `test` and `typecheck`
cache-invalidate when upstream JIT packages change source. JIT packages
(`ui`, `design-system`) export raw TypeScript; only `shot-graph` produces a
build artifact (the single-file HTML bundle via Vite). The server has no build
step.

`test` and `test:coverage` also depend on `^build`. This is load-bearing, not
belt-and-braces: `server.ts` resolves `@gaggiuino/shot-graph/app.html` at module
load, and that export points at `dist/`, so `apps/server`'s tests cannot even
import the module until shot-graph has been built. Without the dependency,
`turbo run test build` is free to start `test` first and fail on a clean
checkout.

Biome runs as a root task (`//#lint`) — fast enough not to need decomposing.
Knip runs as a root task (`//#knip`) too: it is a whole-graph dead-code
analyzer, not something that decomposes per-package. `.github/workflows/ci.yml` runs knip as
part of the turbo `check` job, plus an informational JSON summary into the job summary.

The `react`, `test`, and `turborepo` lint domains are active and were verified
firing (`useJsxKeyInIterable`, `noFocusedTests`, `noUndeclaredEnvVars`).
`nursery.preset` is set to `recommended` but grants **no** rules under Biome
2.5.4 — a nursery rule such as `noImpliedEval` stays silent under the project
config and only fires via `--only`. Nursery rules appear to be opt-in by name
regardless of preset, which is reasonable for unstable rules. The key is kept
for forward compatibility, but do not read it as nursery coverage: there is
none. Enable a specific nursery rule by naming it explicitly if you want it.

Storybook uses co-located stories: story files in `packages/` are excluded from
the root `build` inputs (`!**/*.stories.{ts,tsx,mdx}`) so story edits do not
bust unrelated build caches.

Package boundaries are enforced via `turbo boundaries`. Five tags: `app`,
`mcp-app`, `shared-ui`, `design-system`, `config`. Apps cannot cross-import,
mcp-apps cannot cross-import, `design-system` sits at the bottom. There is no
`shared-data` tag — `normalize.ts` lives in `apps/server`, not a shared package.

Do NOT change root `lint` to `turbo run lint` (infinite loop).

## Docker

Built via `turbo prune @gaggiuino/server --docker`. The build stage uses
`--filter=@gaggiuino/server^...` to build only the server's workspace
dependencies (the shot-graph MCP App), excluding the server itself since it is
JIT. The runner is distroless and runs as UID 65534 with no shell.

The server resolves the MCP App at runtime via
`createRequire(...).resolve("@gaggiuino/shot-graph/app.html")`, so the package
must declare an `./app.html` export and a `dist/` build output, and the runner
stage must `COPY` that `dist/` explicitly.

The turbo version installed in the toolchain stage is read from root
`package.json`, so a Dependabot turbo bump cannot drift from the image. The Bun
base image version is pinned separately in the two `FROM oven/bun:` lines and is
watched by Dependabot's docker ecosystem (`.github/dependabot.yml`). Those pins
must stay equal to root `package.json`'s `packageManager`, which is what CI
installs Bun from — a skew means the tests run on a different runtime than the
one that ships. Dependabot only bumps the image side, so `ci.yml`'s **Bun
version skew** step fails the build when the two disagree; fix it by bumping
`packageManager` to match.

`*.local.yaml` is excluded from the build context — those files carry personal
equipment configuration and must never be baked into a published image. Users who
want them mount them read-only over `/app/apps/server/src/data/`; the commented
`volumes:` block in `docker-compose.yml` is the template.

### Compose files

`docker-compose.yml` consumes the published image
(`ghcr.io/ljcl/gaggiuino-mcp:${GAGGIUINO_MCP_TAG:-latest}`) and has no `build:` key, so a
fresh host runs the server without a checkout. `docker-compose.build.yml` is the override
that adds `build:` back for local source builds; it tags the result `:dev` and sets
`pull_policy: build` so compose can never silently substitute a pulled image for one you
meant to build. Keep the two files' service name in sync — the override merges by service
name, and a rename breaks the build path silently.

Deliberately **not** an auto-loaded `docker-compose.override.yml`: that would make every
`docker compose up` on a checkout build from source, which is the behaviour this change
moves away from.

### Verifying the image locally

`docker-compose.yml` uses `network_mode: host`, which works as intended on a
Linux Docker host but does **not** publish the port to the host on macOS
(Docker Desktop runs containers in a VM). On a Mac, `curl
http://localhost:8000/health` fails even when the container is perfectly
healthy — do not read that as a broken image. Check the container's own view
instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker inspect --format '{{.State.Health.Status}}' gaggiuino-mcp   # -> healthy
docker exec gaggiuino-mcp /usr/local/bin/bun --eval \
  'fetch("http://localhost:8000/health").then(r=>console.log(r.status))'
```

The runner has no shell, so `docker exec ... /bin/sh` fails by design; exec the
bun binary directly (it is the image's ENTRYPOINT) as above.

## CI

`.github/workflows/ci.yml` runs two jobs on every pull request against `main`, every push to
`main`, and a weekly schedule.

- **`check`** — checkout, the composite `.github/actions/setup` action (Bun, Turborepo cache,
  `bun install --frozen-lockfile`), a **Bun version skew** guard asserting root
  `package.json`'s `packageManager` matches the Dockerfile's `oven/bun` base tags, then
  Biome as a dedicated step outside turbo
  (`bun run lint --reporter=github`) so its GitHub reporter's `::error`/`::warning` annotations
  land inline on the PR diff — a turbo task-name prefix would stop GitHub parsing them. PRs then
  run `turbo run test typecheck build knip --affected` plus `turbo boundaries`; pushes to `main`
  run the same tasks unscoped (full check). Both continue with Playwright Chromium setup,
  `turbo run test:stories:coverage`, `turbo run test:coverage`, a coverage-baseline restore/publish
  (`coverage:summary` into the job summary, with a delta vs the cached `main` baseline), a baseline
  save on `main` pushes, the bundle size budget, and an informational knip JSON summary into the
  job summary.
- **`audit`** — `bun audit --audit-level=high`. Advisory (`continue-on-error`) on PRs and `main`
  pushes, since most findings are transitive deps with no local fix; hard-failing on the weekly
  `schedule` trigger so new advisories still surface between PRs.

### Bundle size budget

`scripts/bundle-size.ts` asserts raw and gzip ceilings on
`packages/shot-graph/dist/app.html` — the body re-sent as the `ui://shot-graph/app.html`
resource on every render — and prints a markdown table for the job summary. Budgets sit
~10% over the measured size; raising one is a deliberate one-line diff.

Two details are load-bearing. It runs **outside turbo** so the markdown reaches the job
summary without a task-name prefix on every line (same reason Biome does). And the CI step
builds shot-graph explicitly before calling it with `--strict`, because the PR path runs
`--affected` and would otherwise skip the build — the default is lenient so
`check:affected` does not fail locally, but a gate that silently no-ops in CI is not a gate.

Why recharts is not being replaced, with the measured per-dependency split, is recorded in
`docs/plans/2026-07-27-shot-graph-bundle-budget.md`.

### Required status checks

Branch protection requires three contexts, applied by `scripts/setup-branch-protection.sh`:
`check` (ci.yml), `docker` (docker.yml), and `pr-title` (pr-title.yml).

`docker` is an aggregate job that reports the matrix build's result rather than the build
legs themselves — a matrix job's status context embeds its parameters (`build (linux/amd64,
ubuntu-latest)`), so requiring those directly would leave protection waiting forever on a
context that stops reporting the day a runner label changes. It passes on `skipped`, which
is the docs-only PR case the `changes` path filter exists to produce.

`pr-title` runs on `pull_request_target`; its check run still attaches to the PR head SHA,
so requiring it works (verified against the live API).

Only `GITHUB_TOKEN` is required for `ci.yml` itself. Docker publishing (`docker.yml`),
release-please (`release-please.yml`), and the MCP registry publish (`publish-mcp.yml`) are
live — see Releases below. So is the Storybook Pages deploy (`storybook.yml`): the repo is
public and Pages builds from Actions, so a red run there is a real regression to chase.

## Storybook

`apps/storybook` renders co-located stories: story files live next to their component in
`packages/shot-graph/src` and `packages/ui/src`, plus standalone docs-style stories in
`packages/design-system/stories`. `main.ts` registers `@storybook/addon-mcp`,
`@storybook/addon-vitest`, `@storybook/addon-a11y`, and `@storybook/addon-docs`.

### Story smoke tests

Every story also runs as a Vitest browser-mode smoke test: `bun run test:stories` locally, cached
as the `//#test:stories` turbo root task (inputs: story/package sources and the Storybook config).
`.github/workflows/ci.yml`'s `check` job runs this on every PR and main push. The root
`vitest.stories.config.ts` (deliberately not `vitest.config.ts` — vitest searches parent
directories for a config, so a default-named root config would hijack `apps/server`'s bare
`vitest run`) defines a single `storybook` project via `@storybook/addon-vitest`'s `storybookTest`
plugin and renders each story in headless Chromium (Playwright). The project's `test.dir` must
stay at the repo root: the addon pins the project root to `apps/storybook` (configDir's parent)
but resolves the co-located story globs against `test.dir`, and with the two misaligned no story
files are found. Needs Playwright browsers (`bunx playwright install chromium --with-deps`).
Browser resolution: `launchOptions.executablePath` comes from
`resolveChromiumExecutablePath()` (`scripts/playwright-chromium.ts`), which returns `undefined` —
a no-op — whenever Playwright's own pinned build is installed (the normal case, local or CI). It
only resolves a path in sandboxes that ship a *different* pre-installed Chromium and block the
download (`PLAYWRIGHT_BROWSERS_PATH`/`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pass through turbo for
this).

`bun run test:stories:coverage` runs the same smoke tests plus v8 render-path coverage of every
`packages/*` source the stories execute in the browser, writing `coverage-stories/coverage-summary.json`
(cached as `//#test:stories:coverage`, gitignored). The `storybookTest` addon pins the project root
to `apps/storybook`, so `coverage.allowExternal: true` in `vitest.stories.config.ts` is
load-bearing — without it every `packages/*` file is "external" and the report is empty. Plain
`bun run test:stories` stays coverage-free for fast local runs.

Each story also runs a per-story accessibility check via `addon-a11y`'s Vitest integration (axe-core),
visible in Storybook's Accessibility panel and in each test's reporting output. The default
`a11y.test: "todo"` parameter means a violation is recorded, not asserted — `bun run test:stories`
does not currently fail on an accessibility defect. Treat the panel as a review aid today; a
stricter `test: "error"` gate remains a candidate for future work.

There is intentionally **no pixel-level visual-regression gate**.

### Story screenshots

`bun run shots --list` prints every story id; `bun run shots <id>...` renders one or more to PNGs
under the gitignored `story-shots/` directory (`scripts/story-shots.ts`). It builds (or reuses) a
static Storybook and drives headless Chromium via Playwright, sharing the same
`resolveChromiumExecutablePath()` fallback as the story smoke tests. Useful flags: `--width`/`--height`,
`--dark`, `--hover <selector>` (with `--hover-at x,y`), `--globals`, and `--url` to shoot a running
`bun run storybook` dev server instead of the static build.

These are **look-at-it artifacts for visual review, never committed baselines** — there is
deliberately no pixel-level visual-regression gate (see above), so nothing diffs these PNGs against
a prior run. They exist so a human or an agent without a reachable browser tab can see what a story
actually renders.

### Autodocs

`@storybook/addon-docs` generates a **Docs** page for every component from its stories, JSDoc, and
react-docgen prop table, enabled with the `autodocs` tag applied project-wide.

Placement is load-bearing: the tag must be a literal named export in the project's own
`apps/storybook/.storybook/preview.tsx` (`export const tags = ["autodocs"]`) — Storybook merges
named preview exports with the default `definePreview(...)` export, but the docs indexer only
picks up project tags declared there, not tags nested inside the `definePreview` call itself. The
addon is registered in both `main.ts` (manager UI) and the `definePreview` `addons` array (docs
rendering), mirroring how `addon-a11y` is wired.

### Agent access

- Storybook ships a Model Context Protocol server (via `@storybook/addon-mcp`)
  with story, docs, and test tools. The endpoint is pre-wired in `.mcp.json`:
  `storybook` at `http://localhost:6006/mcp` (while `bun run storybook` runs).
- The `main` Storybook is hosted on GitHub Pages at
  https://ljcl.github.io/gaggiuino-mcp/ (`storybook.yml`) for browsing; it is a
  static build with no MCP endpoint.

`storybook.yml` deploys on every push to `main` that touches `packages/**`,
`apps/storybook/**`, `bun.lock`, root `package.json` or `turbo.json`, the composite
setup action, or the workflow itself. It is live and green, so a failed Pages deploy
is a real regression to chase, not an expected state. It also carries a
`workflow_dispatch` trigger, so a transient Pages failure can be retried without
pushing a dummy commit.

`apps/storybook` depends on `@gaggiuino/ui` even though nothing in that workspace
imports it: Storybook finds ui's stories by directory glob in `main.ts`, and the
dependency is what puts ui in turbo's `build:storybook` task graph. Without it a
ui-only merge cache-hit and redeployed the previous `storybook-static` — the change
never reached Pages. `knip.config.ts` carries a matching `ignoreDependencies` entry,
and `apps/storybook/turbo.json` uses the repo's `dependsOn: ["topo", ...]` JIT pattern.

## Testing the MCP endpoint

```bash
# Health check
curl http://localhost:8000/health

# Initialize session
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}'
```

## Environment Variables

| Variable              | Default                  | Description                                       |
| --------------------- | ------------------------ | ------------------------------------------------- |
| `GAGGIUINO_URL`       | `http://gaggiuino.local` | Gaggiuino machine URL                             |
| `PORT`                | `8000`                   | Server port                                       |
| `HOST`                | `0.0.0.0`                | Bind address                                      |
| `MCP_AUTH_TOKEN`      | _(unset)_                | Bearer secret for `/mcp`; unset serves it open    |
| `MCP_ALLOWED_ORIGINS` | _(empty)_                | Browser origins allowed on `/mcp`; `*` allows any |
| `MCP_ALLOWED_HOSTS`   | _(empty)_                | `Host` values to accept; empty disables the check |
| `LOG_LEVEL`           | `info`                   | `debug`/`info`/`warn`/`error`/`silent`            |

## The HTTP surface

`index.ts` is bootstrap only — read the environment, serve, wire the signals —
which is why it stays out of the coverage set. Everything it delegates to is
covered:

- `http.ts` — `createFetchHandler({ security })` returns a `fetch` plus the live
  session map. Tests drive it with real `Request` objects and never bind a port.
- `mcpAuth.ts` — `loadSecurityConfig` / `checkRequest` / `describeSecurity`,
  plus `handlePreflight` / `corsHeaders`. `checkRequest` returns the `Response`
  to send, or `undefined` to proceed.
- `mcpSession.ts` — the bounded, expiring transport registry. Generic over a
  minimal `ClosableSession`, and its clock is injected, so its tests assert
  "after 31 minutes of silence" without a timer or a wait.

Five things about the gate are load-bearing:

- **`/health` is routed before it.** The container HEALTHCHECK presents no
  credential and no `Origin`; a liveness probe that needs a token reports the
  token's health.
- **Origin is checked before the token.** Otherwise the 401/403 split tells an
  unauthenticated cross-origin prober whether a token is configured at all.
- **An absent `Origin` always passes.** Non-browser clients (Claude Desktop,
  `curl`) send none, so the empty default allowlist blocks exactly the
  browser-initiated cross-origin case and nothing else. That is what lets the
  default be deny-all without breaking every install.
- **An allowed origin gets CORS headers, not just a pass.** Clearing
  `checkOrigin` is half a cross-origin request; without
  `Access-Control-Allow-Origin` on the way back the browser discards a response
  the server was happy to send, so `MCP_ALLOWED_ORIGINS` allowed an origin that
  still could not talk to the server. `handlePreflight` answers `OPTIONS` (which
  used to 405), and `Access-Control-Expose-Headers: mcp-session-id` is
  mandatory — it is not CORS-safelisted, and a Streamable HTTP client that
  cannot read it has no session to continue with. Preflights settle *before*
  the token check, because a browser sends `OPTIONS` with no `Authorization`
  header by design; they still require an allowlisted Origin.
- **Every rejection is logged** (`security.rejected`, with method, origin, and
  status). Silent 401s and 403s made the two failures an operator actually hits
  indistinguishable from the server being unreachable.

Validation runs as middleware in `fetch` rather than through the transport's
`enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` options:
those are all `@deprecated` as of SDK 1.30.0 in favour of external middleware,
and doing it here rejects a request before the body is read or a transport is
allocated.

`secretsMatch` hashes both values before `timingSafeEqual`. That is not
decoration — `timingSafeEqual` throws on a length mismatch, and the obvious
guard (`a.length !== b.length`) leaks the secret's length. Two SHA-256 digests
are always 32 bytes.

`scripts/test-auth.sh` probes a running server for all of the above. It tests
bearer auth, not OAuth — the server implements no OAuth and advertises no
discovery document.

### Session lifetime

Sessions expire on an idle TTL (30 min) and are capped (64). The two are not
redundant: the TTL reclaims sessions whose client vanished without a DELETE — a
dropped tunnel, a restarted host — and the cap bounds anything that outruns it.
`tryReserve()` sweeps *before* it refuses, so a burst of abandoned sessions
cannot lock out a client that arrives later; over the cap the handler answers
503 rather than allocating.

Two ordering details in `sweep()` are load-bearing. It deletes each entry before
calling `close()`, because the real transport's `onclose` calls straight back
into `delete` — closing first means mutating the map mid-iteration. And each
`close()` is individually caught, so one transport that refuses to die does not
strand the rest of the sweep. Both have tests named after the failure.

`index.ts` handles **SIGTERM as well as SIGINT** — `docker stop` sends SIGTERM,
so handling only SIGINT meant the container was killed after the grace period
with every session still open. It stops the listener before draining, so nothing
lands on a transport that is closing.

**An unrecognised session id is a 404 on every method**, and the distinction
from 400 is the whole point: 404 is the Streamable HTTP spec's signal that a
session is gone and the client should re-handshake with `initialize`. GET and
DELETE used to answer 400 — "your request is malformed" — for an expired session
as well as a missing header, and no client recovers from that by re-handshaking,
so a session the idle TTL reclaimed stranded its client instead of prompting a
reconnect. 400 now means only what it says: the `Mcp-Session-Id` header is
absent.

### Logging, health, and startup validation

`logging.ts` writes one JSON object per line to stderr, each with an `event`
name (`tool.call`, `session.opened`, `security.unauthenticated`,
`config.invalid`, …). The level resolves **lazily on first use**, not at module
load — that is what lets `test-setup.ts` call `setLogLevel("silent")` and have
it apply regardless of import order. `createLogger` takes an injectable sink and
clock so `logging.test.ts` asserts whole records without capturing stderr; the
tool-call assertions in `server.test.ts` deliberately spy on the real
`console.error` instead, so the default sink stays in the loop.

Every tool call is one record with `tool`, `durationMs`, and `outcome`. On an
expected failure it also carries `reason` — the same actionable text the model
got, because a bare `"error"` throws away the only useful part. A genuine bug
logs `tool.error` at error level with the stack.

`/health` returns JSON (`buildHealth` in `health.ts`) and **stays 200 while the
machine is unreachable**. That is load-bearing: the container HEALTHCHECK reads
the status code, and the espresso machine is switched off most of the day.
Upstream state is a field, never the status code.

`machine.state` is observed from the requests the server already makes
(`recordUpstream` in `client.ts`), not from a probe — the upstream is an ESP32
on Wi-Fi and a timer-driven ping would load the one device the caching work in
#30 is trying to spare. So an unused server honestly reports `unknown`. Any HTTP
response counts as reachable, including a 404: it proves the network path works.
`resetClient` clears the observed state along with the client, so one test's
failed fetch cannot leak into the next.

`config.ts` validates `PORT` and `GAGGIUINO_URL` before the port is bound and
names the offending variable. `PORT` previously went through a bare `Number()`
with no NaN guard, and `GAGGIUINO_URL` was never parsed — a missing `http://`
surfaced much later as a failed fetch blamed on the machine being offline.

## Backlog and issue tracking

Improvements and changes are tracked as GitHub Issues and triaged on the
"gaggiuino-mcp backlog" Project board (https://github.com/users/ljcl/projects/2).

- Labels: `type:*` mirrors Conventional Commit types (feat, fix, perf, refactor,
  docs, test, chore, ci); `area:*` maps to monorepo packages (server, mcp-app,
  ui, design-system, ci-release, docker, repo).
- Priority (P1/P2/P3), Effort (S/M/L), and Status live as Project board fields,
  not labels, so triage data is not duplicated across two systems.
- Link PRs with `closes #N`; the PR title is the Conventional Commit that
  release-please turns into a release.
- After an epic, breaking change, or wide refactor merges, run the
  `backlog-sweep` skill.

### Editing the project board

- **Local sessions**: `gh project` commands. Discover ids with
  `gh project item-list 2 --owner ljcl --format json` and
  `gh project field-list 2 --owner ljcl --format json`.
- **Cloud and iOS sessions**: the `github-projects` MCP server from `.mcp.json`
  (auth via `GH_MCP_PAT`). Pass numeric field ids via `fields`, and use option
  ids rather than option names for single-select values.

Board constants: project number 2, owner `ljcl`, node id `PVT_kwHOABzAhM4BeYXa`,
database id `24741338`.

| Field | Node id | Numeric id | Options |
| --- | --- | --- | --- |
| Status | `PVTSSF_lAHOABzAhM4BeYXazhYzCy0` | `372443949` | Backlog `f75ad846`, Ready `a057814c`, In progress `47fc9ee4`, In review `2ba31d84`, Done `98236657` |
| Priority | `PVTSSF_lAHOABzAhM4BeYXazhYzCzg` | `372443960` | P1 `fc38b480`, P2 `d2ef2472`, P3 `5197fbf4` |
| Effort | `PVTSSF_lAHOABzAhM4BeYXazhYzCzk` | `372443961` | S `ed6278ac`, M `c5c30106`, L `7270adf2` |

## Releases

Releases are automated by release-please (`.github/workflows/release-please.yml`).

- PRs are squash-merged, so the **PR title becomes the only commit on `main`**. The PR
  title therefore must be a Conventional Commit, or release-please sees no releasable
  change and silently skips (the run still reports success). The `pr-title.yml` workflow
  enforces this on every PR, and the repo squash setting is pinned to `PR_TITLE` so the
  title is always what lands. Branch commits can be messy; only the PR title matters.
- Use Conventional Commits: `fix:` gives a patch bump, `feat:` a minor bump,
  `feat!:` or a `BREAKING CHANGE:` footer a major bump. `chore:`, `docs:`, `refactor:`,
  and `ci:` are valid titles but produce no release.
- release-please opens a `chore: release X.Y.Z` PR that bumps root `package.json`,
  the top-level `server.json` version, and `CHANGELOG.md`. (The OCI package tag inside
  `server.json` is NOT templated — `publish-mcp.yml` stamps it from the git tag at
  publish time, since release-please's json updater cannot rewrite part of a string.)
- Merging that PR pushes the `vX.Y.Z` tag (via the `RELEASE_PLEASE_PAT` secret), which
  triggers `docker.yml` to publish `ghcr.io/ljcl/gaggiuino-mcp:X.Y.Z` and `:X.Y`, and
  `publish-mcp.yml` to publish `server.json` to the MCP registry via GitHub OIDC.
  The registry proves image ownership by pulling the GHCR image and checking its
  `io.modelcontextprotocol.server.name` label (set in `apps/server/Dockerfile`, must
  match `name` in `server.json`); `publish-mcp.yml` therefore polls GHCR until
  `docker.yml`'s manifest exists before publishing.
- That GHCR wait distinguishes three states, and the distinction is the whole point.
  The **existence** poll is authenticated (GHCR creates packages private even under a
  public repo, so an unauthenticated poll answers `unauthorized` forever and times out
  blaming a Docker run that succeeded). Once the manifest exists, a second request with
  an **anonymous** pull token decides: 200 proceeds, 401/403 fails immediately telling
  you to make the package public, 404 retries briefly for tag propagation. Package
  visibility is UI-only — GitHub exposes no REST endpoint for it.
- Published manifests carry supply-chain attestations: an SPDX SBOM and max-mode
  provenance per architecture from BuildKit, plus a Sigstore-signed provenance statement
  for the multi-arch index pushed to GHCR as a referrer. Verification commands are in
  `SECURITY.md`.
- Manual `git tag vX.Y.Z` still works as a fallback; both `docker.yml` and
  `publish-mcp.yml` trigger on `v*` tags regardless of how they are created.
- Commits that only touch `docs/`, `.agents/`, or `.claude/` are excluded from release
  parsing (`exclude-paths` in `release-please-config.json`), so a mislabeled `fix:` on a
  planning doc cannot cut an empty release. A commit touching excluded and non-excluded
  paths still counts.
- Dependabot uses `fix(deps):` for production npm deps and Docker base images (they ship
  inside the published image, so a bump must cut a patch release to reach users) and
  `chore(deps)`/`chore(ci)` for dev tooling and GitHub Actions (no shipped artifact, no
  release). The npm groups are split by dependency-type so one grouped PR never mixes
  the two prefixes.
- To force a specific version, land an empty commit on `main` with a `Release-As` footer
  (`git commit --allow-empty -m "chore: force release" -m "Release-As: X.Y.Z"`); the
  release PR retargets on the next run. `release-please.yml` also has a
  `workflow_dispatch` trigger for re-running after a transient failure or a Release-As
  commit without pushing anything.
