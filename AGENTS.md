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
  source). This repo has no `.github/` yet; a later phase adds CI and release workflows.

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

## Verification sweep

Run this gate before declaring a task complete or opening a PR.

```bash
bun run check              # lint + test + typecheck + build + knip + boundaries (Turborepo)
bun run check:affected     # same, scoped to packages affected by the diff
bun run knip               # Dead code / unused export analysis
docker compose build       # Server container builds from current sources
```

## Commands

```bash
bun install               # Install all deps (workspace-aware)
bun run build             # Build all packages (via Turborepo)
bun run build:affected    # Build only packages affected by the diff
bun run test              # Run all tests (via Turborepo)
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
analyzer, not something that decomposes per-package. There is no `.github/`
in this repo yet, so CI does not run knip. That lands in a later phase.

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

## Storybook

`apps/storybook` renders co-located stories from `packages/shot-graph`, `packages/ui`, and
`packages/design-system`. Only `@storybook/addon-mcp` is registered. There are no story smoke
tests, no accessibility addon, no autodocs, and no hosted build yet. A later phase adds these.

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

No release automation exists yet: no `server.json`, no published Docker image, no
release-please. Versioning is manual (`package.json` version fields). A later phase adds
release-please, an MCP registry `server.json`, and a Docker publish workflow.
