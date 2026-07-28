import { createHash, timingSafeEqual } from "node:crypto";
import { type LogFields } from "./logging";

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

function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.includes("*") || allowed.includes(origin);
}

function checkOrigin(req: Request, allowed: string[]): Response | undefined {
  const origin = req.headers.get("origin");
  // No Origin means no browser, and therefore no cross-origin confused deputy.
  if (origin === null) return undefined;
  if (originAllowed(origin, allowed)) return undefined;
  return jsonRpcError(403, `Forbidden: Origin not allowed: ${origin}`);
}

/**
 * The request headers a Streamable HTTP client sends. `mcp-session-id` and
 * `mcp-protocol-version` are the transport's own; `last-event-id` is how a
 * client resumes a dropped SSE stream. Omitting any one of them makes the
 * browser fail the preflight for a request the allowlist was meant to permit.
 */
const ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
].join(", ");

const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Response headers that let an allowed browser origin actually read the reply.
 *
 * Passing `checkOrigin` is only half of a cross-origin request: without
 * `Access-Control-Allow-Origin` on the way back, the browser discards a
 * response the server was perfectly happy to send, so `MCP_ALLOWED_ORIGINS`
 * would allow an origin the client still could not talk to.
 *
 * `mcp-session-id` must be exposed explicitly — it is not a CORS-safelisted
 * response header, and a Streamable HTTP client that cannot read it has no
 * session to continue with.
 *
 * The origin is echoed rather than answered with `*` so the allowlist stays the
 * thing that decides, and `Vary: Origin` keeps a cache from serving one
 * origin's answer to another.
 */
export function corsHeaders(
  req: Request,
  config: SecurityConfig,
): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin === null || !originAllowed(origin, config.allowedOrigins)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "mcp-session-id",
    Vary: "Origin",
  };
}

/**
 * Answer a CORS preflight, or `undefined` if this is not one.
 *
 * Preflights are deliberately settled before the token check: the browser sends
 * `OPTIONS` with no `Authorization` header by design, so gating it on the token
 * rejects every credentialed cross-origin request before it is ever made. The
 * exemption gives nothing away — a preflight has no body and no side effects,
 * and it is still refused unless the Origin is on the allowlist.
 */
export function handlePreflight(
  req: Request,
  config: SecurityConfig,
): Response | undefined {
  if (req.method !== "OPTIONS") return undefined;

  const cors = corsHeaders(req, config);
  if (Object.keys(cors).length === 0) {
    const origin = req.headers.get("origin");
    return jsonRpcError(
      403,
      `Forbidden: Origin not allowed: ${origin ?? "(none)"}`,
    );
  }

  return new Response(null, {
    headers: {
      ...cors,
      "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
      "Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, POST",
      "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
    },
    status: 204,
  });
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

export interface SecurityReport {
  event: string;
  fields: LogFields;
  level: "info" | "warn";
}

/**
 * Describe the gate for the startup banner, loudly when there is no gate.
 *
 * Returning records rather than printing them keeps this testable and keeps
 * every write to stderr inside `index.ts`. Each carries a `message` an operator
 * can read directly, because the two conditions worth noticing here — no token,
 * and a wildcard origin — are ones somebody needs to act on, not grep for.
 */
export function describeSecurity(config: SecurityConfig): SecurityReport[] {
  const reports: SecurityReport[] = [];

  if (config.token) {
    reports.push({
      event: "security.auth",
      fields: { message: "Bearer token required on /mcp", mode: "bearer" },
      level: "info",
    });
  } else {
    reports.push({
      event: "security.unauthenticated",
      fields: {
        message:
          "WARNING: /mcp is unauthenticated — anyone who can reach this port can control the machine. Set MCP_AUTH_TOKEN before exposing it beyond your LAN (Tailscale Funnel, cloudflared, ngrok).",
        mode: "none",
      },
      level: "warn",
    });
  }

  if (config.allowedOrigins.includes("*")) {
    reports.push({
      event: "security.origins",
      fields: {
        allowed: "*",
        message:
          "WARNING: MCP_ALLOWED_ORIGINS=* — any web page the user visits can reach /mcp",
      },
      level: "warn",
    });
  } else {
    reports.push({
      event: "security.origins",
      fields: {
        allowed: config.allowedOrigins,
        message:
          config.allowedOrigins.length > 0
            ? `Browser origins allowed: ${config.allowedOrigins.join(", ")}`
            : "No browser origins allowed; requests without an Origin header are unaffected",
      },
      level: "info",
    });
  }

  if (config.allowedHosts.length > 0) {
    reports.push({
      event: "security.hosts",
      fields: {
        allowed: config.allowedHosts,
        message: `Host header allowed: ${config.allowedHosts.join(", ")}`,
      },
      level: "info",
    });
  }

  return reports;
}
