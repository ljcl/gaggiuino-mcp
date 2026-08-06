import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ALL_SCOPES, ALL_SCOPES_HEADER } from "./scopes";

/**
 * RFC 9728 protected-resource metadata, and the `WWW-Authenticate` challenges
 * that point a client at it.
 *
 * This is the half of OAuth that has nothing to do with issuing tokens: it makes
 * the endpoint *discoverable*. Without it a client gets a 401 it cannot act on,
 * which is precisely the failure Anthropic documents — "with no metadata to
 * read, Claude never learns where your authorization server is, and the
 * connection fails with 'Couldn't reach the MCP server.'" It is also the
 * diagnosed cause of anthropics/claude-ai-mcp#410, where claude.ai web and
 * mobile failed against a URL that Claude Code connected to happily, because
 * Claude Code probes `.well-known` as a fallback and the hosted surfaces rely on
 * the header.
 */

/** Where this server's own OAuth configuration lives, once it is configured. */
export interface OAuthConfig {
  /**
   * The authorization server's issuer identifier — a bare origin.
   *
   * Keeping it an origin is what collapses RFC 8414's path-insertion rule, so
   * `/.well-known/oauth-authorization-server` is the correct and only path the
   * built-in authorization server has to serve.
   */
  issuer: string;
  /**
   * The RFC 8707 canonical resource identifier: the MCP endpoint itself.
   *
   * This is a security boundary — it is what an access token's `aud` is checked
   * against — so it is derived from `MCP_PUBLIC_URL` and never from the `Host`
   * header, which the caller controls.
   */
  resource: string;
  /** Signing secret for self-issued tokens. */
  secret: string;
}

/**
 * Both well-known paths, in the order a client probes them.
 *
 * The path-suffixed form comes first because that is what Claude tries first
 * when the resource URL has a path component, and `/mcp` always does. Both serve
 * the same body: the bare form is what Anthropic's own diagnostic checklist
 * curls, so serving only one of them fails a check that is meant to pass.
 */
export const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
] as const;

/**
 * Build the advertised document, validated against the SDK's own schema on the
 * way out.
 *
 * Same rule `toJsonSchema` already applies to tool schemas: what this server
 * advertises is generated and validated, never hand-typed into a literal that
 * can drift from the code enforcing it.
 */
export function protectedResourceMetadata(
  config: OAuthConfig,
): Record<string, unknown> {
  return OAuthProtectedResourceMetadataSchema.parse({
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    resource: config.resource,
    resource_documentation: "https://github.com/ljcl/gaggiuino-mcp",
    resource_name: "Gaggiuino MCP",
    scopes_supported: [...ALL_SCOPES],
  });
}

/** The absolute URL a `WWW-Authenticate` challenge points at. */
function metadataUrl(config: OAuthConfig): string {
  return `${config.issuer}${PROTECTED_RESOURCE_PATHS[0]}`;
}

/**
 * Serialize `WWW-Authenticate` parameters as RFC 7235 quoted-strings.
 *
 * Every value here is server-controlled, but a `"` or `\` leaking into a
 * quoted-string would let a value terminate the parameter it is inside, so they
 * are escaped rather than trusted to never appear.
 */
function challenge(params: Record<string, string>): string {
  const parts = Object.entries(params).map(
    ([name, value]) => `${name}="${value.replace(/(["\\])/g, "\\$1")}"`,
  );
  return `Bearer ${parts.join(", ")}`;
}

/**
 * The challenge for a request with no usable token.
 *
 * `resource_metadata` is the pointer that makes the 401 actionable, and `scope`
 * is not decoration: omitting it makes Claude request everything the metadata
 * advertises in `scopes_supported`, which produces a broader consent prompt than
 * the request actually needs.
 */
export function invalidTokenChallenge(config: OAuthConfig): string {
  return challenge({
    error: "invalid_token",
    error_description: "Authentication required",
    resource_metadata: metadataUrl(config),
    scope: ALL_SCOPES_HEADER,
  });
}

/**
 * The challenge for a valid token that lacks the scope for what it just asked
 * to do. Names every scope, not the missing one — see `ALL_SCOPES_HEADER`.
 */
export function insufficientScopeChallenge(config: OAuthConfig): string {
  return challenge({
    error: "insufficient_scope",
    error_description: "This tool changes the machine and needs espresso:write",
    resource_metadata: metadataUrl(config),
    scope: ALL_SCOPES_HEADER,
  });
}

/**
 * Answer a well-known probe, or `undefined` when the path is not one.
 *
 * Routed ahead of the security gate by the caller. That is not an oversight to
 * be tightened later: a document a client fetches *in order to* authenticate
 * cannot itself require authentication, which is the same reasoning that puts
 * `/health` ahead of the gate.
 */
export function handleMetadataRequest(
  pathname: string,
  config: OAuthConfig | undefined,
): Response | undefined {
  if (!(PROTECTED_RESOURCE_PATHS as readonly string[]).includes(pathname)) {
    return undefined;
  }
  // While OAuth is unconfigured the routes are not mounted at all, so an
  // unconfigured server is byte-for-byte what it was before this existed.
  if (!config) return undefined;
  return Response.json(protectedResourceMetadata(config), {
    // Claude caches discovery documents globally by URL for about five minutes;
    // saying so explicitly keeps an intermediary from caching them for longer.
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
