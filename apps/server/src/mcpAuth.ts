import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Request-level gate for `/mcp`.
 *
 * The documented deployment publishes this port to the public internet through
 * a tunnel, so the endpoint needs two independent guards:
 *
 * - **A shared secret.** Anyone who learns the tunnel URL otherwise gets the
 *   full tool surface against a machine on the LAN.
 * - **Origin validation.** Even on a purely local install, any web page the
 *   user visits can POST to `http://localhost:8000/mcp` from their browser.
 *   That is the DNS-rebinding case the Streamable HTTP spec requires guarding,
 *   and no token protects against it, because the browser is not the attacker —
 *   it is the confused deputy.
 *
 * This runs as middleware in the fetch handler rather than through the
 * transport's `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins`
 * options: those are all marked `@deprecated` as of SDK 1.30.0, pointing at
 * external middleware instead. Doing it here also means validation happens
 * before the body is read and before a session or transport is allocated, so a
 * rejected request costs nothing.
 */

/** Advertised in `WWW-Authenticate` on a 401. */
const REALM = "gaggiuino-mcp";

export interface SecurityConfig {
  /**
   * Host header values to accept. Empty disables host validation — tunnel
   * hostnames vary per deployment, so requiring an allowlist by default would
   * break every install for defense-in-depth that Origin validation already
   * covers.
   */
  allowedHosts: string[];
  /**
   * Origin header values to accept, or `["*"]` to accept any.
   *
   * Empty is the safe default rather than an unconfigured one: a request with
   * no Origin (curl, Claude Desktop, anything that is not a browser) is always
   * allowed through, so an empty allowlist blocks exactly the browser-initiated
   * cross-origin requests and nothing else.
   */
  allowedOrigins: string[];
  /** Shared secret, or `undefined` to serve `/mcp` unauthenticated. */
  token?: string;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): SecurityConfig {
  const token = env.MCP_AUTH_TOKEN?.trim();
  return {
    allowedHosts: parseList(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
    token: token ? token : undefined,
  };
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Hashing first is what makes this safe for values of different lengths:
 * `timingSafeEqual` throws on a length mismatch, and the obvious guard against
 * that (`a.length !== b.length` early return) leaks the secret's length. Two
 * SHA-256 digests are always 32 bytes, so the comparison is uniform.
 */
export function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Extract the credential from `Authorization: Bearer <token>`. */
function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function jsonRpcError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: { code: -32000, message },
      id: null,
      jsonrpc: "2.0",
    }),
    { headers: { "Content-Type": "application/json", ...headers }, status },
  );
}

function checkOrigin(req: Request, allowed: string[]): Response | undefined {
  const origin = req.headers.get("origin");
  // No Origin means no browser, and therefore no cross-origin confused deputy.
  if (origin === null) return undefined;
  if (allowed.includes("*") || allowed.includes(origin)) return undefined;
  return jsonRpcError(403, `Forbidden: Origin not allowed: ${origin}`);
}

function checkHost(req: Request, allowed: string[]): Response | undefined {
  if (allowed.length === 0) return undefined;
  const host = req.headers.get("host");
  if (host && allowed.includes(host)) return undefined;
  return jsonRpcError(403, `Forbidden: Host not allowed: ${host ?? "(none)"}`);
}

function checkToken(
  req: Request,
  token: string | undefined,
): Response | undefined {
  if (!token) return undefined;
  const presented = bearerToken(req.headers.get("authorization"));
  if (presented !== undefined && secretsMatch(presented, token)) {
    return undefined;
  }
  return jsonRpcError(401, "Unauthorized: a valid bearer token is required", {
    "WWW-Authenticate": `Bearer realm="${REALM}"`,
  });
}

/**
 * Returns the rejection to send, or `undefined` to let the request through.
 *
 * Origin and Host are checked before the token so that an unauthenticated
 * cross-origin probe cannot use the difference between 401 and 403 to discover
 * whether a token is configured at all.
 */
export function checkRequest(
  req: Request,
  config: SecurityConfig,
): Response | undefined {
  return (
    checkOrigin(req, config.allowedOrigins) ??
    checkHost(req, config.allowedHosts) ??
    checkToken(req, config.token)
  );
}

/**
 * One-line description of the gate for the startup banner, and a loud warning
 * when there is no gate at all. Returning the lines rather than printing them
 * keeps this testable and keeps every write to stderr in `index.ts`.
 */
export function describeSecurity(config: SecurityConfig): string[] {
  const lines: string[] = [];
  if (config.token) {
    lines.push("Auth: bearer token required on /mcp (MCP_AUTH_TOKEN)");
  } else {
    lines.push(
      "WARNING: /mcp is unauthenticated. Anyone who can reach this port can",
      "         control the machine. Set MCP_AUTH_TOKEN before exposing it",
      "         beyond your LAN (Tailscale Funnel, cloudflared, ngrok).",
    );
  }
  lines.push(
    config.allowedOrigins.includes("*")
      ? "Origins: ALL allowed (MCP_ALLOWED_ORIGINS=*) — browser pages can reach /mcp"
      : `Origins: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(", ") : "none (browser requests rejected)"}`,
  );
  if (config.allowedHosts.length > 0) {
    lines.push(`Hosts: ${config.allowedHosts.join(", ")}`);
  }
  return lines;
}
