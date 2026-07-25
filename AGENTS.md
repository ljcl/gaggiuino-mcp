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
- `packages/ui/` - Shared presentational React components (Legend, Skeleton, Tooltip)
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
  source). `.github/workflows/ci.yml` runs CI on every PR and main push; release and
  publish workflows are still a later phase.

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

## MCP App (Shot Graph)

https://modelcontextprotocol.io/docs/extensions/apps

The `view_shot_graph` tool renders an interactive Recharts chart in MCP-compatible hosts.

- Uses `@modelcontextprotocol/ext-apps` SDK with React hooks (`useApp`, `useHostStyles`)
- Bundled as single HTML file via `vite-plugin-singlefile` (~930KB)
- Served as MCP resource at `ui://shot-graph/app.html`
- Calls `get_shot_raw_json` (app-only visibility) to fetch data after render
- Supports shot comparison overlay

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

`bun run coverage:summary` (`scripts/coverage-summary.ts`) globs every `apps/*/coverage/coverage-summary.json`
and `packages/*/coverage/coverage-summary.json`, plus `coverage-stories/coverage-summary.json` when
present, into one markdown table. Packages without a report (no tests, or coverage not run) are
simply absent from the table. It also diffs against a `coverage-baseline/` directory when one
exists. `.github/workflows/ci.yml`'s `check` job restores that baseline from cache before calling
this script and re-saves it after main pushes, so PR job summaries show deltas vs `main`.

## Verification sweep

Run this gate before declaring a task complete or opening a PR.

```bash
bun run check              # lint + test + typecheck + build + knip + boundaries (Turborepo)
bun run check:affected     # same, scoped to packages affected by the diff
bun run knip               # Dead code / unused export analysis
bun run test:stories       # Every story renders in headless Chromium (needs Playwright browsers)
docker compose build       # Server container builds from current sources
```

## Commands

```bash
bun install               # Install all deps (workspace-aware)
bun run build             # Build all packages (via Turborepo)
bun run build:affected    # Build only packages affected by the diff
bun run test              # Run all tests (via Turborepo)
bun run test:coverage     # Run tests with coverage (apps/server only has thresholds)
bun run coverage:summary  # Aggregate coverage-summary.json reports into a markdown table
bun run test:stories      # Run every Storybook story as a Vitest browser-mode smoke test
bun run test:stories:coverage # Same, plus render-path coverage into coverage-stories/
bun run typecheck         # TS across every workspace package
bun run typecheck:affected # Typecheck only packages affected by the diff
bun run lint               # Biome, repo-wide (NOT `turbo run lint` — infinite loop)
bun run lint:fix           # Biome, applying fixes
bun run boundaries         # turbo boundaries (tag-based layering check)
bun run check              # lint + test + typecheck + build + boundaries
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

# Docker
docker compose build
docker compose up -d
docker compose logs -f
```

## Turborepo

A `topo` transit node in `turbo.json` makes `test` and `typecheck`
cache-invalidate when upstream JIT packages change source. JIT packages
(`ui`, `design-system`) export raw TypeScript; only `shot-graph` produces a
build artifact (the single-file HTML bundle via Vite). The server has no build
step.

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
base image version is pinned separately and is watched by Dependabot's docker
ecosystem (added in a later phase).

`*.local.yaml` is excluded from the build context — those files carry personal
equipment configuration and must never be baked into a published image.

### Verifying the image locally

`docker-compose.yml` uses `network_mode: host`, which works as intended on a
Linux Docker host but does **not** publish the port to the host on macOS
(Docker Desktop runs containers in a VM). On a Mac, `curl
http://localhost:8000/health` fails even when the container is perfectly
healthy — do not read that as a broken image. Check the container's own view
instead:

```bash
docker compose up -d
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
  `bun install --frozen-lockfile`), then Biome as a dedicated step outside turbo
  (`bun run lint --reporter=github`) so its GitHub reporter's `::error`/`::warning` annotations
  land inline on the PR diff — a turbo task-name prefix would stop GitHub parsing them. PRs then
  run `turbo run test typecheck build knip --affected` plus `turbo boundaries`; pushes to `main`
  run the same tasks unscoped (full check). Both continue with Playwright Chromium setup,
  `turbo run test:stories:coverage`, `turbo run test:coverage`, a coverage-baseline restore/publish
  (`coverage:summary` into the job summary, with a delta vs the cached `main` baseline), a baseline
  save on `main` pushes, and an informational knip JSON summary into the job summary.
- **`audit`** — `bun audit --audit-level=high`. Advisory (`continue-on-error`) on PRs and `main`
  pushes, since most findings are transitive deps with no local fix; hard-failing on the weekly
  `schedule` trigger so new advisories still surface between PRs.

Only `GITHUB_TOKEN` is required for `ci.yml` itself. Docker publishing (`docker.yml`),
release-please (`release-please.yml`), and the MCP registry publish (`publish-mcp.yml`) are
wired up in this phase — see Releases below. GitHub Pages (`storybook.yml`) is wired up too,
but cannot actually deploy until the repo goes public, in the final phase of this plan.

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
stricter `test: "error"` gate is a candidate for a later phase.

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
- The `main` Storybook is hosted on GitHub Pages (`storybook.yml`) for browsing;
  it is a static build with no MCP endpoint.

`storybook.yml` cannot succeed yet: GitHub Pages deployment requires the repo to be
public and Pages set to build from GitHub Actions. Both land in the final phase of
this plan (Task 21). Until then, pushes to `main` will run this workflow and it will
fail at the Pages deployment step — that is expected, not a regression to chase.

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

| Variable        | Default                  | Description           |
| --------------- | ------------------------ | --------------------- |
| `GAGGIUINO_URL` | `http://gaggiuino.local` | Gaggiuino machine URL |
| `PORT`          | `8000`                   | Server port           |
| `HOST`          | `0.0.0.0`                | Bind address          |

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
