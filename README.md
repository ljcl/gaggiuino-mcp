# Gaggiuino MCP Server

A Remote [MCP](https://modelcontextprotocol.io) server for integrating a [Gaggiuino](https://gaggiuino.github.io/) espresso machine with AI tools. Ask your AI assistant to check machine status, analyze shot data, and get dial-in guidance.

## Features

### MCP Tools

**Shot Analysis**
- `get_status` - Current machine status (temperature, pressure, flow, weight)
- `get_latest_shot_id` - Most recent shot, id and headline numbers in one call
- `list_recent_shots` - The last few shots summarised, for trends over a session
- `get_shot_data` - Structured shot summary with metrics
- `get_shot_raw_data` - Complete time-series data
- `view_shot_graph` - Interactive shot graph rendered in MCP-compatible hosts (pressure, flow, weight over time with target overlays and optional shot comparison)

**Profiles and Settings**
- `list_profiles` - Profiles on the machine, merged with this server's documentation
- `get_profile_info` - Everything known about one profile
- `get_machine_settings` - Boiler, steam, and scale configuration as the machine reports it
- `get_maintenance_status` - Descale and backflush history the machine tracks itself, with shots since each
- `get_dial_in_guidance` - Expert guidance for analyzing espresso shots
- `select_profile` - Switch the active profile (changes the machine; requires an authenticated server)
- `upload_profile` - Save a new brew profile to the machine (changes the machine; requires an authenticated server). Creates only — it never updates, and the machine assigns a fresh id every time, so uploading twice leaves two profiles

**MCP Prompts** - workflow templates your host surfaces as slash commands or menu items:

- `dial_in_new_bag` - first shots on a coffee you have not pulled before (bean, and optionally roast level, dose, and what you want in the cup)
- `diagnose_last_shot` - read the shot you just pulled against how it tasted (what was wrong, and optionally what you changed)
- `choose_profile` - pick a profile the machine actually holds for a coffee (roast level, and optionally drink and notes)
- `espresso_shot_analyst` - the dial-in guidance as a system prompt (same content as `get_dial_in_guidance`)

Each workflow prompt lays out the tools to call in order, so the analysis starts from the machine's own data rather than a guess.

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
| `MCP_PUBLIC_URL` | _(unset)_ | Public `https` origin clients reach this server on, with no path (e.g. `https://box.tailnet.ts.net`). Set together with `MCP_OAUTH_SECRET` to enable OAuth. It is advertised as the OAuth `resource`, so it must match the URL you enter in the client exactly. |
| `MCP_OAUTH_SECRET` | _(unset)_ | Signing key for self-issued OAuth tokens, at least 32 characters (`openssl rand -hex 32`). Keep it stable across restarts so clients stay signed in. Setting only one of these two fails at startup. |
| `MCP_OAUTH_PASSPHRASE_HASH` | _(unset)_ | scrypt hash of the passphrase you type on the consent page when connecting a client. Required whenever OAuth is on — without it the consent page would grant a token to anyone who reached it, so the server refuses to start. Generate with `cd apps/server && bun run hash-passphrase`; never store the passphrase itself. |
| `MCP_AUTH_TOKEN` | _(unset)_ | Legacy shared secret presented as `Authorization: Bearer <token>` on `/mcp`. **A Claude connector cannot present this** — the custom-connector dialog has no request-header field — so use the OAuth variables above for Claude. OAuth takes precedence when both are configured. |
| `MCP_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated browser origins allowed to call `/mcp`. `*` allows any (unsafe). |
| `MCP_ALLOWED_HOSTS` | _(empty)_ | Comma-separated `Host` header values to accept. Empty disables the check. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. Logs are one JSON object per line on stderr. |

### Health and logs

`GET /health` returns JSON:

```json
{
  "status": "ok",
  "version": "1.1.0",
  "uptimeSec": 3412,
  "machine": {
    "url": "http://gaggiuino.local",
    "state": "unreachable",
    "lastCheckedAt": "2026-07-27T21:11:15.274Z",
    "lastError": "Unable to connect. Is the computer able to access the url?",
    "versions": {
      "coreVersion": "a06f97fd",
      "frontVersion": "a06f97fd",
      "staticVersion": "a06f97fd"
    }
  }
}
```

It answers `200` whenever the process is alive, **including while the machine is
unreachable** — your espresso machine is off most of the day, and the container
healthcheck reads the status code. `machine.state` is `ok`, `unreachable`, or
`unknown`, observed from the requests the server already makes rather than from
a probe, so `/health` puts no extra load on the machine. `machine.versions` is
observed the same way — remembered the first time anything reads the machine's
settings (`get_machine_settings`), never fetched by `/health` itself — so `null`
there means "this server has not read the settings yet", not "the machine
reports no version". Only those three documented fields are published: `/health`
is unauthenticated, so anything a future firmware adds under `versions` stays
out of it until someone decides otherwise.

Logs are one JSON object per line, so you can pick out what you need:

```bash
docker compose logs -f | jq -c 'select(.event == "tool.call" and .outcome != "ok")'
```

### Securing the endpoint

**Turn on OAuth before exposing this server beyond your LAN.** Every tunnel
option below puts `/mcp` on the public internet, and without authentication
anyone who learns the URL gets the full tool surface against a machine in your
kitchen. The server prints a warning at startup while nothing is configured.

Three variables, all required together:

```bash
# 1. The public origin clients will reach the server on — no path, https only.
#    This is advertised as the OAuth `resource`, so it must match the URL you
#    type into Claude exactly.
MCP_PUBLIC_URL=https://your-machine.tail-scale.ts.net

# 2. The key your tokens are signed with. Keep it stable across restarts, or
#    every restart signs you out of your phone.
openssl rand -hex 32

# 3. The passphrase you will type on the consent page. Store the hash, never
#    the passphrase — this prompts and prints the whole line to paste in.
cd apps/server && bun run hash-passphrase >> ../../.env
```

**Then recreate the container — a plain restart is not enough:**

```bash
docker compose up -d --force-recreate
```

Compose tracks the *list* of `env_file` paths, not their contents, so editing
`.env` and running `docker compose up -d` (or `restart`) can reuse the existing
container along with the environment it was created with. The new variables
never reach the process and the server comes up unauthenticated exactly as if
you had not set them — with no error, because from its point of view nothing is
configured. Check what actually arrived:

```bash
docker inspect gaggiuino-mcp --format '{{range .Config.Env}}{{println .}}{{end}}' | grep MCP_
```

Setting only some of them fails at startup and names the missing one. That is
deliberate: silently falling back to an open endpoint is how somebody exposes a
tunnel believing it is protected. **The corollary is worth knowing when
diagnosing:** a server that is *running* and unauthenticated has seen none of
the three — if you believe you set them, the container is stale, not the config
wrong.

#### Why OAuth and not a shared token

`MCP_AUTH_TOKEN` still works for clients that can set their own headers, but **a
Claude connector cannot use it.** A connector is added at the account level so
one entry has to work on claude.ai, Claude Desktop and iOS, and on a personal
plan the "Add custom connector" dialog offers an OAuth Client ID and Secret and
no request-header field. A local stdio bridge is not a way around it either — it
cannot run on iOS. So on the deployment this project is built for, the token can
never leave the client and the two write tools stay permanently refused.

When you connect, Claude discovers the endpoint, sends you to a consent page
served by this server, and you type the passphrase. There is nothing to
register and no client secret to store.

#### What each part protects

`/health` and the `/.well-known/*` discovery documents are deliberately
unauthenticated — the container's healthcheck presents no credential, and a
document a client fetches *in order to* authenticate cannot itself require
authentication.

`select_profile` and `upload_profile` — the two tools that change the machine —
need the `espresso:write` scope. A token without it gets a `403` that prompts
Claude to ask you for the extra permission rather than failing silently. With
nothing configured at all they refuse to run and say so, which is why an open
server is a defensible default for a LAN and a machine-control tool on one is
not.

Requests carrying an `Origin` header are rejected unless the origin is listed in
`MCP_ALLOWED_ORIGINS`. This is what stops any web page you happen to visit from
POSTing to a server running on your own network — a token does not help there,
because the browser sends it for you. Requests with no `Origin` (Claude Desktop,
`curl`, anything that is not a browser) are unaffected, so the default empty list
is the right setting for almost everyone.

Listing an origin also makes `/mcp` answer that origin's CORS preflight and
echo `Access-Control-Allow-Origin` (plus `Access-Control-Expose-Headers:
mcp-session-id`, without which a browser client can read the handshake but not
the session it needs to continue with). Allowing an origin the browser then
blocks would be an allowlist that allows nothing.

`scripts/test-auth.sh` probes a running server for all of the above — the
discovery chain, the shape of the `401`, cross-host redirects and origin
validation. **Run it from outside your LAN.** Every failure it catches is a
failure of the URL *as Claude reaches it*, and the one that bites most often —
`MCP_PUBLIC_URL` disagreeing with the URL you typed into Claude — is invisible
from localhost.

```bash
BASE_URL=https://your-machine.tail-scale.ts.net ./scripts/test-auth.sh
```

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

> Every option in this section publishes `/mcp` to the internet. Turn on OAuth
> first — see [Securing the endpoint](#securing-the-endpoint) — and set
> `MCP_PUBLIC_URL` to the exact origin you are about to publish.

Whichever ingress you pick, three things decide whether it works:

- **One origin serves everything.** `/mcp`, `/.well-known/*` and `/oauth/*` all
  have to be reachable at `MCP_PUBLIC_URL`. That is what keeps this one
  container.
- **Use a stable hostname.** A quick-tunnel hostname that rotates on restart
  changes the advertised `resource`, and the connector breaks every time.
- **No cross-host redirects.** If the registered URL `301`/`302`/`307`/`308`s to
  a different host, the `Authorization` header is dropped on the way. This is
  the usual cause of "works in MCP Inspector or Claude Code but not claude.ai" —
  apex-to-`www` canonicalisation in front of the server is the common way to hit
  it. `scripts/test-auth.sh` checks for it.

Claude caches discovery documents globally by URL for about five minutes, so a
metadata change is not live immediately — and a broken deploy's metadata can be
served for a few minutes after you fix it.

### Tailscale Funnel (Recommended)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes your server to the internet via a secure HTTPS URL:

```bash
tailscale funnel --bg 8000
# URL: https://your-machine.tail-scale.ts.net/mcp

# then, in your .env
MCP_PUBLIC_URL=https://your-machine.tail-scale.ts.net
```

**Funnel, not Serve.** Claude reaches your connector from Anthropic's own
infrastructure, and it refuses a hostname before sending a byte if any resolved
address is not globally routable — explicitly including `100.64.0.0/10`, which
is the tailnet's own range. `tailscale serve` publishes exactly those addresses.
Funnel publishes public records pointing at Tailscale's relays instead.
Connectors are also IPv4-only, so a hostname publishing only `AAAA` records
cannot be reached. One check covers both:

```bash
dig +short your-machine.tail-scale.ts.net   # must return a routable IPv4 address
```

Two things people reach for here and should not:

- **Do not allowlist Anthropic's egress range (`160.79.104.0/21`) as an access
  control.** Funnel does not forward the client IP, and `/oauth/authorize` is
  reached by *your own browser*, not by Anthropic — so an IP allowlist breaks
  the login while protecting nothing.
- **Do not trust the `Tailscale-User-Login` header.** `tailscaled` does strip
  forged copies, but only on traffic it proxies. This project ships
  `network_mode: host` with `HOST=0.0.0.0`, so the listener is directly
  reachable and anything on the host can set that header itself. Believing it
  would be a write-scoped authentication bypass.

### Cloudflare Tunnel

Use [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to create a persistent tunnel to your server. Use a **named** tunnel with a
hostname you own, not a quick tunnel — a `trycloudflare.com` hostname changes on
every restart, and `MCP_PUBLIC_URL` has to change with it.

### ngrok

```bash
ngrok http 8000
```

Same caveat: a free ngrok hostname rotates. Reserve a domain, or expect to
re-add the connector each time.

### Behind your own reverse proxy

Proxy all three paths — `/mcp`, `/.well-known/*` and `/oauth/*` — to the same
upstream, and set `MCP_PUBLIC_URL` to the public origin. The proxy must not
canonicalise across hosts (see the redirect note above), and it must pass the
`Authorization` header through untouched.

### Using an external identity provider

Not yet supported — the built-in authorization server is the only mode. If you
already run Authentik, Authelia, Keycloak, Zitadel, Kanidm or `tsidp` and would
rather point at it, that is tracked in
[#110](https://github.com/ljcl/gaggiuino-mcp/issues/110).

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
