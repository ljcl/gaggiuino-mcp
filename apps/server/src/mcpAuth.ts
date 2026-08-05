import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfigError, parsePublicUrl } from "./config";
import { type LogFields } from "./logging";
import { invalidTokenChallenge, type OAuthConfig } from "./oauth/metadata";
import { ALL_SCOPES, parseScopes } from "./oauth/scopes";
import { type TokenFailure, verifyToken } from "./oauth/tokens";

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
  /**
   * OAuth configuration, or `undefined` when this server is not an OAuth
   * resource server. Requires both a public URL to answer as and a secret to
   * sign with; either one alone is an incomplete configuration and is treated
   * as unconfigured rather than half-mounted.
   */
  oauth?: OAuthConfig;
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

/**
 * The path `MCP_PUBLIC_URL` is combined with to form the resource identifier.
 *
 * This must match the URL the user types into the connector dialog exactly,
 * path component included — Anthropic's troubleshooting page is explicit that a
 * mismatch here produces a token that is issued happily and then rejected on
 * every request.
 */
const MCP_PATH = "/mcp";

/**
 * Shortest secret worth accepting.
 *
 * The documented recipe is `openssl rand -hex 32`, which is 64 characters. This
 * floor exists to reject a placeholder somebody typed by hand, not to grade
 * entropy — the signing key is HKDF-derived from whatever is here, so a weak
 * secret means forgeable access tokens.
 */
const MIN_SECRET_LENGTH = 32;

function loadOAuthConfig(
  env: Record<string, string | undefined>,
): OAuthConfig | undefined {
  const issuer = parsePublicUrl(env.MCP_PUBLIC_URL);
  const secret = env.MCP_OAUTH_SECRET?.trim();

  // Half a configuration is a deployment mistake, not a mode. Silently falling
  // back to the previous behaviour is how somebody exposes a tunnel believing
  // it is OAuth-gated, so this fails at startup and names what is missing —
  // the same contract `config.ts` has for PORT and GAGGIUINO_URL.
  if (issuer && !secret) {
    throw new ConfigError(
      "MCP_PUBLIC_URL is set but MCP_OAUTH_SECRET is not, so OAuth cannot be enabled. Generate one with `openssl rand -hex 32`, or unset MCP_PUBLIC_URL.",
    );
  }
  if (secret && !issuer) {
    throw new ConfigError(
      "MCP_OAUTH_SECRET is set but MCP_PUBLIC_URL is not, so this server does not know the URL its tokens are issued for. Set MCP_PUBLIC_URL to the public origin clients reach it on, or unset MCP_OAUTH_SECRET.",
    );
  }
  if (!issuer || !secret) return undefined;

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `MCP_OAUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters; it is the key every access token is signed with. Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  return { issuer, resource: `${issuer}${MCP_PATH}`, secret };
}

export function loadSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): SecurityConfig {
  const token = env.MCP_AUTH_TOKEN?.trim();
  return {
    allowedHosts: parseList(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
    oauth: loadOAuthConfig(env),
    token: token ? token : undefined,
  };
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * The MAC is what makes this safe for values of different lengths:
 * `timingSafeEqual` throws on a length mismatch, and the obvious guard against
 * that (`a.length !== b.length` early return) leaks the secret's length. Two
 * HMAC-SHA256 digests are always 32 bytes, so the comparison is uniform.
 *
 * **The key is random per call and then discarded**, which is the standard
 * double-HMAC comparison. It matters for two reasons. An equal digest is
 * evidence of an equal input only within this call, so there is no stable value
 * anywhere that could be precomputed, replayed or compared against a rainbow
 * table — and structurally, a digest under a key nobody kept cannot be password
 * storage, which is what this function keeps being mistaken for.
 *
 * **It is a comparison, and it must not become password storage.** Putting
 * scrypt or argon2 here would run a deliberately slow KDF on the
 * unauthenticated path of every request — roughly 100 ms of CPU per attempt on
 * the hardware this ships to, which hands a denial-of-service primitive to
 * anyone who can reach the port. The inputs are machine-generated secrets
 * (`openssl rand -hex 32`) rather than human passwords, and nothing is
 * persisted, so neither of the things a slow KDF buys applies.
 *
 * A *stored* passphrase hash is the opposite case and does need a real KDF:
 * that is `MCP_OAUTH_PASSPHRASE_HASH`, which uses scrypt. Its derived key is
 * then compared here — scrypt to derive, this to compare.
 */
export function secretsMatch(a: string, b: string): boolean {
  const key = randomBytes(32);
  const mac = (value: string) =>
    createHmac("sha256", key).update(value, "utf8").digest();
  return timingSafeEqual(mac(a), mac(b));
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

/** How a caller got through the gate, and what it is allowed to ask for. */
export interface AuthGrant {
  /**
   * `none` — no credential is configured, so `/mcp` is open. Writes are still
   * refused, by `writeToolDisabled`, with text that explains why.
   * `bearer` — the legacy `MCP_AUTH_TOKEN` matched.
   * `oauth` — a verified access token.
   */
  mode: "none" | "bearer" | "oauth";
  /** Scopes the caller holds. Empty on a refusal. */
  scopes: readonly string[];
  /** Token subject, when there was one. Logged; never sent to the caller. */
  subject?: string;
}

/**
 * The outcome of checking a credential.
 *
 * Both halves are always present so the caller never has to narrow a union to
 * reach the grant: past the gate, `grant` is authoritative, and on the way out
 * `refusal` is the response to send. Returning them together is also what lets
 * `http.ts` verify a token once and use the same result for both the gate and
 * the scope check, rather than verifying it twice.
 */
export interface AuthOutcome {
  grant: AuthGrant;
  /** The 401 to send, when the presented credential did not check out. */
  refusal?: Response;
  /**
   * Why it was refused, for the operator's log only.
   *
   * The caller is told `invalid_token` and nothing more: telling an
   * unauthenticated prober that its token was *expired* rather than
   * *badly signed* confirms half of a guess. The person who has to fix a real
   * misconfiguration is reading the log, not the response body.
   */
  reason?: TokenFailure | "missing" | "malformed-header" | "bad-token";
}

/** Every scope, for the modes that are not scope-aware. */
const FULL_GRANT: readonly string[] = ALL_SCOPES;

/**
 * Authenticate a request. Never throws; an unusable credential is a refusal.
 *
 * OAuth takes precedence over the legacy shared secret when both are
 * configured, because OAuth is the mechanism a host can actually complete. The
 * shared secret remains for LAN installs that already depend on it, and is
 * removed in its own change once OAuth is proven end to end.
 */
export function authenticate(
  req: Request,
  config: SecurityConfig,
  now: () => number = Date.now,
): AuthOutcome {
  const header = req.headers.get("authorization");

  if (config.oauth) {
    const presented = bearerToken(header);
    if (presented === undefined) {
      return {
        grant: { mode: "oauth", scopes: [] },
        reason: header === null ? "missing" : "malformed-header",
        refusal: jsonRpcError(
          401,
          "Unauthorized: an OAuth access token is required",
          { "WWW-Authenticate": invalidTokenChallenge(config.oauth) },
        ),
      };
    }
    const verdict = verifyToken(presented, {
      audience: config.oauth.resource,
      expectedIssuer: config.oauth.issuer,
      now,
      secret: config.oauth.secret,
    });
    if (!verdict.ok) {
      return {
        grant: { mode: "oauth", scopes: [] },
        reason: verdict.reason,
        refusal: jsonRpcError(
          401,
          "Unauthorized: the access token was not accepted",
          { "WWW-Authenticate": invalidTokenChallenge(config.oauth) },
        ),
      };
    }
    return {
      grant: {
        mode: "oauth",
        scopes: parseScopes(verdict.claims.scope),
        subject: verdict.claims.sub,
      },
    };
  }

  if (config.token) {
    const presented = bearerToken(header);
    if (presented !== undefined && secretsMatch(presented, config.token)) {
      return { grant: { mode: "bearer", scopes: FULL_GRANT } };
    }
    return {
      grant: { mode: "bearer", scopes: [] },
      reason: presented === undefined ? "missing" : "bad-token",
      refusal: jsonRpcError(
        401,
        "Unauthorized: a valid bearer token is required",
        { "WWW-Authenticate": `Bearer realm="${REALM}"` },
      ),
    };
  }

  // No credential configured. Every scope is granted because there is no way to
  // obtain one, and a 403 pointing at an authorization server that does not
  // exist is worse than the honest tool-level refusal `writeToolDisabled` gives.
  return { grant: { mode: "none", scopes: FULL_GRANT } };
}

/**
 * Returns the rejection to send, or `undefined` to let the request through.
 *
 * Origin and Host are checked before the credential so that an unauthenticated
 * cross-origin probe cannot use the difference between 401 and 403 to discover
 * whether authentication is configured at all.
 *
 * `auth` is a parameter so a caller that already authenticated the request can
 * pass the result in rather than have it recomputed; it defaults to doing the
 * work, which is what every test and every non-`/mcp` caller wants.
 */
export function checkRequest(
  req: Request,
  config: SecurityConfig,
  auth: AuthOutcome = authenticate(req, config),
): Response | undefined {
  return (
    checkOrigin(req, config.allowedOrigins) ??
    checkHost(req, config.allowedHosts) ??
    auth.refusal
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

  if (config.oauth) {
    reports.push({
      event: "security.auth",
      fields: {
        issuer: config.oauth.issuer,
        // The advertised `resource`, printed verbatim. A mismatch between this
        // and the URL the user types into Claude is silent — discovery
        // succeeds, a token is issued, and every request 401s — so the one
        // value that has to be right is the one an operator can read back.
        message: `OAuth access token required on /mcp; advertising resource ${config.oauth.resource}`,
        mode: "oauth",
        resource: config.oauth.resource,
      },
      level: "info",
    });
  } else if (config.token) {
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
          "WARNING: /mcp is unauthenticated — anyone who can reach this port can control the machine. Set MCP_PUBLIC_URL and MCP_OAUTH_SECRET to enable OAuth before exposing it beyond your LAN (Tailscale Funnel, cloudflared, ngrok). MCP_AUTH_TOKEN still works for clients that can set their own headers, but a Claude connector cannot.",
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
