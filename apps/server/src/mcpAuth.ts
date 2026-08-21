import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfigError, parseIssuerUrl, parsePublicUrl } from "./config";
import { type LogFields } from "./logging";
import {
  createExternalIssuer,
  type ExternalIssuerOptions,
} from "./oauth/externalIssuer";
import { invalidTokenChallenge, type OAuthConfig } from "./oauth/metadata";
import { isWellFormedHash } from "./oauth/passphrase";
import { ALL_SCOPES, parseScopes } from "./oauth/scopes";
import { type TokenFailure, verifyToken } from "./oauth/tokens";

/**
 * Request-level gate for `/mcp`.
 *
 * The documented deployment publishes this port to the public internet through
 * a tunnel, so the endpoint needs two independent guards:
 *
 * - **An OAuth access token.** Anyone who learns the tunnel URL otherwise gets
 *   the full tool surface against a machine on the LAN.
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
  externalOptions?: ExternalIssuerOptions,
): OAuthConfig | undefined {
  const publicOrigin = parsePublicUrl(env.MCP_PUBLIC_URL);
  const secret = env.MCP_OAUTH_SECRET?.trim();
  const externalIssuer = parseIssuerUrl(env.MCP_OAUTH_ISSUER);

  /**
   * Resource-server-only mode: an external IdP mints the tokens and this server
   * only verifies them.
   *
   * Checked before the secret rules below, because it removes the reason for
   * both of the credentials they demand. Nothing here signs anything — the IdP
   * holds the private key — so `MCP_OAUTH_SECRET` would be a secret with no
   * purpose and `MCP_OAUTH_PASSPHRASE_HASH` a passphrase for a consent page
   * that is never rendered.
   */
  if (externalIssuer) {
    if (!publicOrigin) {
      throw new ConfigError(
        "MCP_OAUTH_ISSUER is set but MCP_PUBLIC_URL is not, so this server does not know the resource its tokens must be audienced for. Set MCP_PUBLIC_URL to the public origin clients reach it on, or unset MCP_OAUTH_ISSUER.",
      );
    }
    // Refused rather than ignored. Both of these are only used by the built-in
    // authorization server, which does not mount in this mode — so a deployment
    // that set them is one whose operator believes something about this server
    // that is not true, and silently dropping them is how that belief survives.
    for (const [name, value] of [
      ["MCP_OAUTH_SECRET", secret],
      ["MCP_OAUTH_PASSPHRASE_HASH", env.MCP_OAUTH_PASSPHRASE_HASH?.trim()],
    ] as const) {
      if (value) {
        throw new ConfigError(
          `${name} is set alongside MCP_OAUTH_ISSUER, but they configure two different things. MCP_OAUTH_ISSUER delegates token issuing to ${externalIssuer}, so this server runs no authorization server and signs nothing — ${name} would have no effect. Unset one of them.`,
        );
      }
    }
    return {
      external: createExternalIssuer(externalIssuer, externalOptions),
      issuer: externalIssuer,
      publicOrigin,
      resource: `${publicOrigin}${MCP_PATH}`,
    };
  }

  // Half a configuration is a deployment mistake, not a mode. Silently falling
  // back to the previous behaviour is how somebody exposes a tunnel believing
  // it is OAuth-gated, so this fails at startup and names what is missing —
  // the same contract `config.ts` has for PORT and GAGGIUINO_URL.
  if (publicOrigin && !secret) {
    throw new ConfigError(
      "MCP_PUBLIC_URL is set but MCP_OAUTH_SECRET is not, so OAuth cannot be enabled. Generate one with `openssl rand -hex 32`, or unset MCP_PUBLIC_URL. To delegate to an external identity provider instead, set MCP_OAUTH_ISSUER.",
    );
  }
  if (secret && !publicOrigin) {
    throw new ConfigError(
      "MCP_OAUTH_SECRET is set but MCP_PUBLIC_URL is not, so this server does not know the URL its tokens are issued for. Set MCP_PUBLIC_URL to the public origin clients reach it on, or unset MCP_OAUTH_SECRET.",
    );
  }
  if (!publicOrigin || !secret) return undefined;

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `MCP_OAUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters; it is the key every access token is signed with. Generate one with \`openssl rand -hex 32\`.`,
    );
  }

  // Mandatory, because the consent page is what stands between a stranger who
  // has found the URL and a token that can drive the machine. Without it
  // `/oauth/authorize` would authorize anyone who asked.
  const passphraseHash = env.MCP_OAUTH_PASSPHRASE_HASH?.trim();
  if (!passphraseHash) {
    throw new ConfigError(
      "MCP_OAUTH_PASSPHRASE_HASH is required when OAuth is enabled — without it the consent page would grant a token to anyone who reaches it. Generate one with `bun run hash-passphrase` in apps/server.",
    );
  }
  if (!isWellFormedHash(passphraseHash)) {
    // The likeliest cause is named first, because it is invisible from the
    // value as written in `.env`: the salt and hash are base64url, so `$<salt>`
    // and `$<hash>` read as variable references and docker compose substitutes
    // them away — inside double quotes too, since only single quotes are
    // literal to its dotenv parser. What arrives here is truncated to
    // `scrypt$16384$8$1`, which looks nothing like what the operator typed.
    throw new ConfigError(
      'MCP_OAUTH_PASSPHRASE_HASH is not a scrypt hash in the expected `scrypt$N$r$p$salt$hash` form. If it looks right in your .env, check the quoting: the value contains `$` and must be SINGLE-quoted, or docker compose substitutes part of it away (it warns `The "..." variable is not set`). Double quotes do not help. Otherwise generate a fresh one with `bun run hash-passphrase` in apps/server, and paste the whole line — not the passphrase itself.',
    );
  }

  return {
    // With the built-in authorization server the two are the same value: this
    // server both mints the tokens and answers as the resource.
    issuer: publicOrigin,
    passphraseHash,
    publicOrigin,
    resource: `${publicOrigin}${MCP_PATH}`,
    secret,
  };
}

export function loadSecurityConfig(
  env: Record<string, string | undefined> = process.env,
  externalOptions?: ExternalIssuerOptions,
): SecurityConfig {
  return {
    allowedHosts: parseList(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
    oauth: loadOAuthConfig(env, externalOptions),
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
 * scrypt or argon2 here would run a deliberately slow KDF on top of one that
 * has already run: the sole caller is `verifyPassphrase`, which passes the two
 * *scrypt outputs* it has just derived. Both inputs are already fixed-length
 * hex digests of a slow KDF, and nothing here is persisted, so neither thing a
 * KDF buys — slowness against guessing, a salt against precomputation — has
 * anything left to add.
 *
 * The stored side is where the real KDF belongs, and that is
 * `MCP_OAUTH_PASSPHRASE_HASH`: scrypt to derive, this to compare.
 */
export function secretsMatch(a: string, b: string): boolean {
  const key = randomBytes(32);
  const mac = (value: string) =>
    createHmac("sha256", key).update(value, "utf8").digest();
  return timingSafeEqual(mac(a), mac(b));
}

/** Extract the access token from `Authorization: Bearer <token>`. */
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
 * legacy client resumes a dropped SSE stream; `mcp-method` and `mcp-name` are
 * the 2026-07-28 revision's mirrored request-metadata headers, required on
 * every modern POST. Omitting any one of them makes the browser fail the
 * preflight for a request the allowlist was meant to permit.
 */
const ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
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
   * `none` — no authorization server is configured, so `/mcp` is open. Writes
   * are still refused, by `writeToolDisabled`, with text that explains why.
   * `oauth` — a verified access token.
   */
  mode: "none" | "oauth";
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
  reason?: TokenFailure | "missing" | "malformed-header";
}

/** Every scope, for the one mode that is not scope-aware. */
const FULL_GRANT: readonly string[] = ALL_SCOPES;

/**
 * Authenticate a request. Never throws; an unusable credential is a refusal.
 *
 * There is one credential now. A shared secret used to be accepted alongside
 * this, and it went because nothing that matters could present it: a connector
 * is added at the account level so it works on claude.ai, Desktop and iOS, and
 * that dialog offers an OAuth client id and secret and no request-header
 * field. Keeping it meant two gate orderings to reason about in exchange for a
 * control the owner could not use.
 */
export async function authenticate(
  req: Request,
  config: SecurityConfig,
  now: () => number = Date.now,
): Promise<AuthOutcome> {
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
    // The only asynchronous step in the gate, and only in the delegated mode:
    // an external issuer's key has to be fetched before an asymmetric signature
    // can be checked. The built-in path stays a synchronous HMAC.
    const verdict = config.oauth.external
      ? await config.oauth.external.verify(presented, {
          audience: config.oauth.resource,
          now,
        })
      : verifyToken(presented, {
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

  // No authorization server configured. Every scope is granted because there is
  // no way to obtain one, and a 403 pointing at an authorization server that
  // does not exist is worse than the honest tool-level refusal
  // `writeToolDisabled` gives.
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
 * pass the result in rather than have it recomputed; omitting it does the work
 * here, which is what every test and every non-`/mcp` caller wants.
 *
 * When it is omitted, authentication is now reached only *after* Origin and Host
 * have passed, where it used to be evaluated eagerly as a default argument. That
 * is a real improvement with an external issuer: verifying a token there can
 * mean a JWKS fetch, and a cross-origin probe should never be able to make this
 * server call out to its IdP.
 */
export async function checkRequest(
  req: Request,
  config: SecurityConfig,
  auth?: AuthOutcome,
): Promise<Response | undefined> {
  return (
    checkOrigin(req, config.allowedOrigins) ??
    checkHost(req, config.allowedHosts) ??
    (auth ?? (await authenticate(req, config))).refusal
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
 * can read directly, because the two conditions worth noticing here — no
 * authorization server, and a wildcard origin — are ones somebody needs to act
 * on, not grep for.
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
  } else {
    reports.push({
      event: "security.unauthenticated",
      fields: {
        message:
          "WARNING: /mcp is unauthenticated — anyone who can reach this port can control the machine. Enable OAuth before exposing it beyond your LAN (Tailscale Funnel, cloudflared, ngrok): set MCP_PUBLIC_URL, MCP_OAUTH_SECRET and MCP_OAUTH_PASSPHRASE_HASH. This is the only way to authenticate; the shared secret MCP_AUTH_TOKEN was removed in 2.0.0 because no Claude connector could present it.",
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
