# Security Policy

gaggiuino-mcp is a remote MCP server that proxies a Gaggiuino espresso
machine's local HTTP API. It holds no credentials, but it does hold the
machine's network address and can carry personal configuration in local
override files.

## Supported versions

Only the latest release receives security fixes. Older tags and the
corresponding `ghcr.io/ljcl/gaggiuino-mcp` images are not patched — upgrade to
the newest version before reporting an issue you can only reproduce on an old
one.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Preferred: [report a vulnerability privately via GitHub](https://github.com/ljcl/gaggiuino-mcp/security/advisories/new)
  (Security tab → "Report a vulnerability").
- Fallback: email <luke@lukeclark.com.au> with "gaggiuino-mcp security" in the
  subject.

Include what you can: affected version or image tag, reproduction steps, and
impact. You can expect an acknowledgement within 7 days and a fix or mitigation
plan within 30 days for confirmed issues. This is a spare-time project, so
those are targets rather than guarantees.

## Scope

In scope:

- The MCP server (`apps/server`): the `/mcp` transport, tool handlers, and the
  YAML loader's handling of `*.local.yaml` override files.
- The published Docker image (`ghcr.io/ljcl/gaggiuino-mcp`).
- The MCP App bundle served as a resource (`ui://shot-graph/app.html`).

Out of scope:

- The Gaggiuino firmware and its own HTTP API — report those upstream.
- Vulnerabilities that require an already-compromised host or a misconfigured
  deployment (for example, exposing the server publicly without the documented
  reverse proxy or tunnel).

## Sensitive data handling

- `GAGGIUINO_URL` points at a device on your local network. Treat it as
  internal topology, not a secret, but do not paste it into public issues.
- `*.local.yaml` override files can carry personal equipment details (grinder,
  basket, workflow notes). They are gitignored and excluded from the Docker
  build context; they must never be committed or baked into an image.
- The server persists nothing to disk and holds no credentials.

If you find machine addresses or local override content leaking anywhere
outside these paths (logs, error messages, MCP tool output), that is a
vulnerability — please report it.
