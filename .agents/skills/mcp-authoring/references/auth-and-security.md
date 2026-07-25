# Auth and Security

This document covers how an MCP server authenticates callers per the MCP authorization spec, plus general security hygiene. Auth here is for HTTP transport; stdio servers use environment credentials instead.

## Transport determines the auth model

- stdio servers do not use the OAuth flow. They read credentials from the environment and pass them through to whatever external services they call.
- HTTP servers act as an OAuth 2.1 resource server. The rest of this document is about HTTP servers.

## The server is an OAuth 2.1 resource server

- Roles: the MCP server is the resource server; the MCP client is the OAuth client; a separate authorization server (possibly co-hosted) issues tokens.
- The server's job is to validate tokens, not to issue them. Token issuance is handled by the authorization server, which may be a separate process or a well-known hosted service.

## Discovery (how clients find your authorization server)

- The server MUST implement OAuth 2.0 Protected Resource Metadata (RFC 9728), served at `/.well-known/oauth-protected-resource`, including an `authorization_servers` field with at least one entry.
- On an unauthenticated request the server MUST return `401` with a `WWW-Authenticate` header pointing at the resource metadata URL. This tells the client where to start the discovery process.
- The client reads that metadata, then fetches the authorization server's metadata (RFC 8414) to learn its endpoints such as the authorization endpoint and token endpoint.

## Token acquisition (client side, for context)

- The client runs OAuth 2.1 with PKCE (MUST). It SHOULD use Dynamic Client Registration (RFC 7591) so it can register without manual setup by the server operator.
- The client MUST include the `resource` parameter (RFC 8707) identifying your server's canonical URI in both the authorization and token requests. This binds the resulting token to your server specifically.

## Token validation (your server's responsibility)

- Validate every request's bearer token before processing (OAuth 2.1 section 5.2). Requests with missing, expired, or invalid tokens MUST be rejected with `401`.
- Audience binding (critical): the server MUST verify the token was issued specifically for it (audience claim per RFC 8707 / RFC 9068). Reject tokens minted for other services even if they are otherwise valid.
- No token passthrough: never forward the client's token to an upstream API. If your server calls an upstream service, it is a separate OAuth client there with a separate token. Passthrough creates the confused-deputy vulnerability.
- Tokens MUST NOT appear in URL query strings; use the `Authorization: Bearer` header.

## Error responses

| Status | Meaning                                         |
| ------ | ----------------------------------------------- |
| 401    | Auth required, or token missing/invalid/expired |
| 403    | Authenticated but insufficient scope/permission |
| 400    | Malformed authorization request                 |

## Canonical server URI

- The `resource` value is your server's canonical URI: scheme + host (+ port/path if needed), no fragment, prefer no trailing slash. Examples: `https://mcp.example.com`, `https://mcp.example.com/mcp`.
- Use the same URI consistently across all discovery metadata and token requests. Inconsistencies cause audience validation failures.

## General security hygiene

- Secrets: never hardcode. Read from `process.env`; document required vars in `.env.example`. Never log tokens or secrets.
- Input validation: validate and sanitize all user input and all external API responses at the boundary (see [server-primitives.md](server-primitives.md)).
- Least privilege: request the narrowest scopes; the server should hold the narrowest credentials that work.
- Transport security: all auth endpoints and redirect URIs MUST be HTTPS (localhost excepted for redirects). Prefer short-lived access tokens; rotate refresh tokens for public clients.

## Checklist

- Resource-server role understood: your server validates tokens, a separate authorization server issues them.
- RFC 9728 metadata endpoint implemented and returns `authorization_servers`.
- `WWW-Authenticate` header returned on `401` pointing at the protected resource metadata URL.
- Audience claim validated on every token: reject tokens not bound to your server's canonical URI.
- No token passthrough to upstream services.
- Correct status codes: `401` for auth failures, `403` for scope failures, `400` for malformed requests.
- Secrets read from environment variables, never hardcoded or logged.
- All auth endpoints served over HTTPS.
- Narrowest scopes and credentials requested and held.
