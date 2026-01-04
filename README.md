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

### 1. Clone and Configure

```bash
git clone https://github.com/your-username/gaggiuino-mcp.git
cd gaggiuino-mcp

cp .env.example .env
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

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GAGGIUINO_URL` | `http://gaggiuino.local` | URL of your Gaggiuino machine |
| `PORT` | `8000` | Port for the MCP server |
| `HOST` | `0.0.0.0` | Host to bind to |

### Customization

The server ships with generic profiles and prompts. You can customize them for your setup without modifying tracked files:

1. **Equipment-specific dial-in guidance** - Copy `apps/server/src/data/prompts.example-local.yaml` to `prompts.local.yaml` in the same directory and add your grinder model, basket, and other equipment details.

2. **Custom profiles** - Copy `apps/server/src/data/profiles.example-local.yaml` to `profiles.local.yaml` to add your own profiles or override/remove defaults (set a profile ID to `null` to remove it).

Local override files (`*.local.yaml`) are gitignored and merged on top of the defaults at startup.

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
bun install          # Install all dependencies

bun run build        # Build all packages (Turborepo)
bun run test         # Run all tests
bun run lint         # Lint all packages

# Server
cd apps/server
bun run dev          # Watch mode
bun run test         # Server tests only

# Shot graph UI
cd packages/shot-graph
bun run storybook    # Storybook on port 6006

# Regenerate JSON schemas (after changing Zod schemas in loader.ts)
cd apps/server
bun run generate-schemas
```

### Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

## Troubleshooting

### Can't connect to gaggiuino.local

mDNS (`.local` hostnames) may not work inside Docker containers. Use the IP address directly in `GAGGIUINO_URL`.

### AI tool can't reach the server

Ensure your server is publicly accessible via HTTPS. Tools like Claude Desktop route requests through their own servers, so Tailnet-only access (e.g. `tailscale serve`) won't work - you need a public tunnel (e.g. `tailscale funnel`).

### Server starts but can't reach Gaggiuino

The container uses `network_mode: host` to share the host's network stack. If your Gaggiuino is on a different network segment, adjust your Docker networking configuration.

## License

MIT
