# OAuth for personal Claude connectors, and why the bearer token cannot stay

Records the decision behind #106–#115. The resource-server half (#106, #107)
ships first; the built-in authorization server (#108, #109) follows; the removal
of `MCP_AUTH_TOKEN` (#111) lands last and only after the flow has been driven
end to end on the owner's own phone (#113).

## What is actually broken

`MCP_AUTH_TOKEN` is a security control the owner cannot use.

A Claude connector is added at the account level, so one entry has to work on
claude.ai, Claude Desktop and the Claude iOS app. On a personal (non-Team) plan
the "Add custom connector" dialog exposes an OAuth Client ID and Client Secret
and **no request-header field**. The header-based path (`static_headers`) is
documented as Beta, and as a credential "entered by an organization administrator
… shared by the organization rather than pasted per user"; the custom-connector
page says it is "being slowly rolled out to customers; contact Anthropic for
early access."

A local stdio bridge is not a way out either — it cannot run on iOS.

So the token can never leave the client, and `select_profile` and
`upload_profile` are permanently refused on the one deployment this repo exists
to serve. That is not a gap to document; it is the feature not working.

## The shape of the replacement

Three pieces, deliberately separable:

1. **Be discoverable** (#106). Serve RFC 9728 protected-resource metadata on both
   well-known paths, and make the 401 carry
   `WWW-Authenticate: Bearer …, resource_metadata=…, scope=…`.
2. **Verify tokens** (#107). Signature, issuer, expiry, and audience via the
   SDK's `checkResourceAllowed`. Scope step-up on the write tools, as a 403 at
   the HTTP layer.
3. **Issue tokens** (#108, #109). A built-in authorization server in the same
   container: `/oauth/authorize`, `/oauth/token`, PKCE, and CIMD instead of a
   client registry.

Steps 1 and 2 are authorization-server-agnostic, which is what makes #110
(delegate to Authentik/Authelia/Keycloak/`tsidp` with one variable) a small
addition rather than a second implementation.

### The 401 pointer is the part that fixes the reported symptom

Anthropic's own troubleshooting text describes the failure exactly: "there's no
`WWW-Authenticate: Bearer resource_metadata=…` header on your `401`, and the
well-known paths on your MCP server's origin return `404`. With no metadata to
read, Claude never learns where your authorization server is, and the connection
fails with 'Couldn't reach the MCP server.'"

This is also the diagnosed cause of
[anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410):
a missing `WWW-Authenticate` made claude.ai web *and* mobile fail while Claude
Code connected to the identical URL, because Claude Code probes `.well-known` as
a fallback and the hosted surfaces rely on the header. Closed as not planned.

### An authentication refusal cannot be a tool result

The single most important implementation constraint, and the one most likely to
be "fixed" back by a future contributor following this repo's own conventions.

AGENTS.md says expected failures are results rather than exceptions, and that
`handleToolCall` is the only dispatch point. Authentication is the exception to
both, because a `200` carrying `isError: true` produces **no auth prompt at
all** — Claude passes the text to the model as a tool result and moves on. The
refusal has to be an HTTP status, which means the scope check has to happen
before the JSON-RPC message reaches the SDK: once a tool handler is running, its
return value is already destined to be wrapped in a `200`.

Hence `checkScopes` in `handleMcp`, ahead of `transport.handleRequest`.

## Rejected architectures

### An identity-aware proxy in front of the server

Put oauth2-proxy, Authelia's forward-auth, Cloudflare Access or Pomerium in
front of `/mcp` and let it do the whole dance.

Rejected because it does not answer the question. Those products authenticate a
**browser** and then set a cookie or a header; an MCP client is not a browser and
carries a bearer token. Claude would still need somewhere to run an OAuth
authorization-code flow with PKCE against a `resource` this server names, and a
proxy that 302s an API request to a login page produces exactly the "works in
MCP Inspector, fails on claude.ai" report. It also breaks the one-container
promise — `docker compose up -d` against one image is the documented deployment —
and it moves the audience check, the thing the MCP spec insists on most, outside
this repo where nothing can test it.

### External identity provider only, with no built-in authorization server

Require Authentik, Authelia, Keycloak, Zitadel, Kanidm or `tsidp`, and ship no
`/oauth/*` at all.

Rejected as the **default**, not as an option — it is #110, and it is worth
having. But making it the only path means the documented deployment for an
espresso machine in a kitchen becomes "first, stand up an identity provider."
For `tsidp` specifically that is a second container, a persistent `/data` volume,
a tailnet ACL grant for `allow_dcr`, `TAILSCALE_USE_WIP_CODE=1`, and an upstream
that describes itself as experimental and pre-1.0. Keycloak additionally has no
RFC 8707 support for the current spec versions, so the audience — the property
the spec most insists on — becomes manual Audience-mapper configuration.

The built-in authorization server is small precisely because of CIMD (below), so
"ship both" costs little.

### Keep `static_headers` and wait for the rollout

Rejected because it is Beta, is described as an organization-administrator
credential rather than a per-user one, and requires contacting Anthropic for
access. Building the product's security model on an unreleased field of a dialog
the owner cannot see is not a plan.

### Dynamic client registration

Rejected for the built-in authorization server. An unauthenticated registration
endpoint and a growing client table on a home server, for zero benefit at one
user — and Anthropic's own documentation notes DCR "causes Claude to register a
new client on every fresh connection."

CIMD removes the need. Both documents are live and self-referential:

```
https://claude.ai/oauth/mcp-oauth-client-metadata      -> client_name "Claude"
https://claude.ai/oauth/claude-code-client-metadata    -> client_name "Claude Code"
```

so there is no client registry, no `POST /register`, and no client-secret
storage. Claude selects CIMD only when the metadata advertises **both**
`client_id_metadata_document_supported: true` **and** `"none"` in
`token_endpoint_auth_methods_supported`; if either is missing it falls back to
hunting for a `registration_endpoint` that deliberately does not exist.

### Mounting the SDK's `mcpAuthRouter`

Rejected. Every server-side auth primitive in `@modelcontextprotocol/sdk` is
Express-shaped — `server/auth/router.d.ts:1` is
`import express, { RequestHandler } from 'express';`. This server is a Bun
`fetch` handler over `WebStandardStreamableHTTPServerTransport`, so adopting it
means Express plus cors plus express-rate-limit inside a distroless image, and
two HTTP stacks in one process.

The SDK's **schemas** (`shared/auth.js`) and **error classes**
(`server/auth/errors.js`) and **audience helper** (`shared/auth-utils.js`) are
framework-neutral and are reused; the handlers are hand-written. Verified
importable from `apps/server` with no Express in the graph.

### Deriving the public URL from the `Host` header

Rejected. It is attacker-controlled, and this value gates audience validation.
Tailscale Funnel terminates TLS and hands the container plain HTTP on a private
address, so the server genuinely cannot infer its own external identity — hence
`MCP_PUBLIC_URL`, validated at startup and printed in the startup banner.

### Emitting the RFC 9207 `iss` parameter on the authorization redirect

Deferred, not adopted.
[anthropics/claude-ai-mcp#540](https://github.com/anthropics/claude-ai-mcp/issues/540)
reports that adding it correlated with Anthropic's backend ceasing to call
`/token` at all: "The single instance where the backend attempted a token
exchange used redirects without `iss`. Every flow after we added `iss` (per RFC
9207) was never exchanged." That is one user's observation rather than an
Anthropic statement — and it is not worth testing on the owner's own connector.

## What is deliberately weak, and why

- **Refresh-token replay detection is bounded, not revocation.** An in-memory
  highest-generation counter, lost on restart. On a single-user server that is a
  reasonable trade for statelessness; the code says so at the point of the
  compromise, which is this repo's convention for a tradeoff that should not be
  quietly undone.
- **Access and refresh tokens are stateless**, signed with keys derived from
  `MCP_OAUTH_SECRET` by HKDF with different `info` strings. Nothing is stored, so
  a `docker compose up` does not sign the owner out of their phone, and the
  distroless runner (UID 65534, no shell) still writes nothing. The cost is that
  revocation means rotating the secret.
- **Tailscale identity is not trusted** (#115). `tailscaled` does strip forged
  `Tailscale-User-Login` headers — verified in `ipn/ipnlocal/serve.go`,
  `addTailscaleIdentityHeaders` — but only on traffic it proxies. This repo ships
  `network_mode: host` and `HOST=0.0.0.0`, so the listener is directly reachable
  and the header is forgeable. Trusting it would be a write-scoped auth bypass.

## The upstream risk this does not remove

There is an open cluster of reports where a spec-compliant self-hosted
authorization server completes authorization and Claude's backend never calls
`/token` (#540, linked to #215, #506, #518), reproduced on claude.ai Web and the
iOS app across manual client_id, CIMD and DCR. None is root-caused.

It sits upstream of every architecture considered here, so it is not a reason to
choose differently — but it is the reason #111 does not delete the working
mechanism until the replacement has been driven end to end on the owner's real
iPhone, and the reason #113 rebuilds `scripts/test-auth.sh` as a discovery probe
that runs from outside the LAN.
