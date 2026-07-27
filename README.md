# Gaggiuino MCP Server

A Remote [MCP](https://modelcontextprotocol.io) server for integrating a [Gaggiuino](https://gaggiuino.github.io/) espresso machine with AI tools. Ask your AI assistant to check machine status, analyze shot data, and get dial-in guidance.

## Features

### MCP Tools

**Shot Analysis**
- `get_status` - Current machine status (temperature, pressure, flow, weight)
- `get_latest_shot_id` - Most recent shot ID
- `get_shot_data` - Structured shot summary with metrics
- `get_shot_raw_data` - Complete time-series data
- `view_shot_graph` - Interactive shot graph rendered in MCP-compatible hosts (pressure, flow, weight over time with target overlays and optional shot comparison)

**Profile Discovery**
- `list_profiles` - All available brew profiles with summaries
- `get_profile_info` - Detailed documentation for a specific profile
- `get_dial_in_guidance` - Expert guidance for analyzing espresso shots

**MCP Prompts** - `espresso_shot_analyst` system prompt for AI-assisted dial-in (same content as `get_dial_in_guidance`)

**MCP Resources** - `gaggiuino://profiles` and `gaggiuino://profiles/{id}` for profile data

## Quick Start

The server is published as a multi-arch image (linux/amd64, linux/arm64) at
[`ghcr.io/ljcl/gaggiuino-mcp`](https://github.com/ljcl/gaggiuino-mcp/pkgs/container/gaggiuino-mcp),
so there is nothing to clone or build. It is also listed in the
[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.ljcl/gaggiuino-mcp)
as `io.github.ljcl/gaggiuino-mcp`.

### 1. Download and Configure

```bash
mkdir gaggiuino-mcp && cd gaggiuino-mcp

curl -O https://raw.githubusercontent.com/ljcl/gaggiuino-mcp/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/ljcl/gaggiuino-mcp/main/.env.example
```

Edit `.env` with your Gaggiuino machine's address:

```bash
# Use the IP directly (recommended)
GAGGIUINO_URL=http://192.168.1.100

# Or if mDNS works on your network
GAGGIUINO_URL=http://gaggiuino.local
```

### 2. Start the Server

```bash
docker compose up -d
```

### 3. Verify

```bash
curl http://localhost:8000/health
```

The server is available at `http://<your-docker-host>:8000/mcp`.

### Choosing a Version

The compose file tracks `latest`. To pin a release, set `GAGGIUINO_MCP_TAG` in `.env`:

```bash
GAGGIUINO_MCP_TAG=1.0    # latest 1.0.x patch
GAGGIUINO_MCP_TAG=1.0.1  # exact release
```

Upgrade with:

```bash
docker compose pull && docker compose up -d
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GAGGIUINO_URL` | `http://gaggiuino.local` | URL of your Gaggiuino machine |
| `PORT` | `8000` | Port for the MCP server |
| `HOST` | `0.0.0.0` | Host to bind to |

### Customization

The server ships with generic profiles and prompts. Two local override files are merged on top of the defaults at startup:

1. **`prompts.local.yaml`** - equipment-specific dial-in guidance (your grinder model, basket, and other equipment details).

2. **`profiles.local.yaml`** - your own profiles, or overrides/removals of the defaults (set a profile ID to `null` to remove it).

Start from the examples:

```bash
curl -O https://raw.githubusercontent.com/ljcl/gaggiuino-mcp/main/apps/server/src/data/prompts.example-local.yaml
curl -O https://raw.githubusercontent.com/ljcl/gaggiuino-mcp/main/apps/server/src/data/profiles.example-local.yaml
```

These hold personal equipment configuration, so they are deliberately never baked into the published image. To use them, uncomment the `volumes:` block in `docker-compose.yml`:

```yaml
volumes:
  - ./profiles.local.yaml:/app/apps/server/src/data/profiles.local.yaml:ro
  - ./prompts.local.yaml:/app/apps/server/src/data/prompts.local.yaml:ro
```

From a repo checkout, copy each `*.example-local.yaml` to `*.local.yaml` alongside it in `apps/server/src/data/` instead - they are gitignored and picked up automatically.

## Connecting to AI Tools

Many AI tools (like Claude Desktop) route MCP requests through their own servers, not from your local machine. This means your MCP server needs to be accessible via a public HTTPS URL.

### Tailscale Funnel (Recommended)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes your server to the internet via a secure HTTPS URL:

```bash
tailscale funnel --bg 8000
# URL: https://your-machine.tail-scale.ts.net/mcp
```

### Cloudflare Tunnel

Use [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to create a persistent tunnel to your server.

### ngrok

```bash
ngrok http 8000
```

### Local Network Only

If your AI tool connects directly (e.g. local MCP server config), use the direct address:

```
http://<docker-host-ip>:8000/mcp
```

### Adding to Claude Desktop

1. Go to **Settings** > **Integrations** > **Add More** > **Add Remote MCP Server**
2. Set the URL to your public HTTPS endpoint (e.g. `https://your-machine.tail-scale.ts.net/mcp`)
3. Save and enable

## Architecture

```
AI Tool (Claude Desktop, etc.)
    |
    |  HTTPS
    v
+-----------------------------+
|  HTTPS Tunnel               |
|  (Tailscale / Cloudflare /  |
|   ngrok / reverse proxy)    |
+-----------------------------+
    |
    |  HTTP (localhost:8000)
    v
+-----------------------------+
|  Gaggiuino MCP Server       |
|  (Docker container)         |
|  Bun + Streamable HTTP      |
+-----------------------------+
    |
    |  HTTP (local network)
    v
+-----------------------------+
|  Gaggiuino                  |
+-----------------------------+
```

## Development

```bash
git clone https://github.com/ljcl/gaggiuino-mcp.git
cd gaggiuino-mcp

bun install          # Install all dependencies

bun run build        # Build all packages (Turborepo)
bun run test         # Run all tests
bun run lint         # Lint all packages
bun run check        # lint + test + typecheck + build + knip + boundaries

# Server
cd apps/server
bun run dev          # Watch mode
bun run test         # Server tests only

# Shot graph UI (run from the repo root)
bun run storybook    # Storybook on port 6006

# Regenerate JSON schemas (after changing Zod schemas in loader.ts)
cd apps/server
bun run generate-schemas
```

The `main` branch Storybook is published to GitHub Pages at
[ljcl.github.io/gaggiuino-mcp](https://ljcl.github.io/gaggiuino-mcp/) — a static build for
browsing the shot-graph and UI components without running anything locally.

### Docker

`docker-compose.yml` pulls the published image. To build and run the image from your
checkout instead, layer the build override on top of it:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
docker compose logs -f
```

The override tags the result `ghcr.io/ljcl/gaggiuino-mcp:dev` so a local build is never
mistaken for a published release.

## Troubleshooting

### Can't connect to gaggiuino.local

mDNS (`.local` hostnames) may not work inside Docker containers. Use the IP address directly in `GAGGIUINO_URL`.

### AI tool can't reach the server

Ensure your server is publicly accessible via HTTPS. Tools like Claude Desktop route requests through their own servers, so Tailnet-only access (e.g. `tailscale serve`) won't work - you need a public tunnel (e.g. `tailscale funnel`).

### Server starts but can't reach Gaggiuino

The container uses `network_mode: host` to share the host's network stack. If your Gaggiuino is on a different network segment, adjust your Docker networking configuration.

## License

[MIT](LICENSE) © Luke Clark
