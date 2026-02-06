# Gaggiuino MCP Server

Remote MCP server for integrating a Gaggiuino espresso machine with AI tools.

## Architecture

- **Runtime**: Bun (TypeScript)
- **Transport**: Streamable HTTP on port 8000 (`/mcp` endpoint)
- **Deployment**: Docker container (any Docker host), exposed via HTTPS tunnel or reverse proxy
- **Monorepo**: Bun workspaces with Turborepo (`apps/*` + `packages/*`)

## Key Directories

- `apps/server/` - MCP server (tools, prompts, resources, client)
- `packages/shot-graph/` - React + Recharts MCP App for interactive shot graphs
- `packages/design-system/` - Shared design tokens and components
- `packages/tsconfig/` - Shared TypeScript configurations
- `apps/server/src/data/profiles/` - YAML profile documentation (not machine profiles)
- `apps/server/src/data/prompts.yaml` - System prompt for espresso dial-in guidance
- `apps/server/src/data/*.example-local.yaml` - Templates for user-specific overrides (copy to `*.local.yaml`)
- `docs/plans/` - Design docs and implementation plans

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

## Commands

```bash
bun install          # Install all deps (workspace-aware)
bun run build        # Build all packages (via Turborepo)
bun run test         # Run all tests (via Turborepo)
bun run lint         # Lint all packages (via Turborepo)
bun run dev          # Dev mode (via Turborepo)

# Server only
cd apps/server
bun run start        # Start server
bun run dev          # Watch mode
bun run test         # Run server tests

# UI development
cd packages/shot-graph
bun run storybook    # Storybook on port 6006
INPUT=app.html bunx vite build  # Rebuild single-file HTML

# Regenerate JSON schemas (after changing Zod schemas in loader.ts)
cd apps/server
bun run generate-schemas

# Docker
docker compose build
docker compose up -d
docker compose logs -f
```

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
