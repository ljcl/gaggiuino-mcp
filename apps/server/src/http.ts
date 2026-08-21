import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildHealth } from "./health";
import { logger } from "./logging";
import {
  type AuthGrant,
  authenticate,
  checkRequest,
  corsHeaders,
  handlePreflight,
  type SecurityConfig,
} from "./mcpAuth";
import { insufficientScopeChallenge } from "./oauth/metadata";
import { createOAuthRouter, type OAuthRouterOptions } from "./oauth/router";
import { protectedToolsIn } from "./oauth/scopeGate";
import { SCOPE_WRITE } from "./oauth/scopes";
import { createServer } from "./server";

/**
 * The HTTP surface, separated from `index.ts` so it can be exercised without
 * binding a port. `index.ts` is only bootstrap — read the environment, serve
 * this handler, wire the signals — which is why it stays out of the coverage
 * set while everything it delegates to is covered.
 *
 * `/mcp` is dual-era, served by the v2 SDK's `createMcpHandler`: the
 * 2026-07-28 revision is served per request (stateless, `_meta` envelope,
 * `server/discover`, `Mcp-Method`/`Mcp-Name` header validation, `resultType`
 * and the cacheable-result stamps), and 2025-era clients are served through
 * the SDK's stateless legacy fallback — a fresh server instance per request
 * instead of one pinned to a session. Protocol sessions are gone with the
 * revision that removed them: no `Mcp-Session-Id` is minted (the 2025 spec
 * always made the header server-optional), and the session operations —
 * GET's standalone stream and DELETE — answer 405, which that spec allows.
 * One `createServer` factory backs both eras, so they cannot drift apart.
 */

export interface FetchHandlerOptions {
  /** Test seam for CIMD resolution, so no test reaches claude.ai. */
  resolveClient?: OAuthRouterOptions["resolve"];
  security: SecurityConfig;
}

export interface FetchHandler {
  fetch(req: Request): Promise<Response>;
  /** Abort in-flight exchanges. Called on SIGTERM/SIGINT after the port stops. */
  shutdown(): Promise<void>;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message }, id: null, jsonrpc: "2.0" }),
    { headers: { "Content-Type": "application/json" }, status },
  );
}

/**
 * Merge CORS headers onto a response without buffering it.
 *
 * A `Response` handed back by the handler may be streaming, so this re-wraps
 * the same `ReadableStream` rather than reading it — an SSE stream must stay
 * open.
 */
function withCors(response: Response, cors: Record<string, string>): Response {
  if (Object.keys(cors).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The successor to the session era's `session.opened` record: which client is
 * this, and is it re-handshaking on every turn? Under stateless legacy
 * serving an `initialize` per turn is the expected cadence rather than a
 * session thrown away, but the client name and negotiated version are still
 * the two facts an operator needs when a host misbehaves — modern-era
 * requests carry the same identity in their `_meta` envelope instead and
 * send no `initialize` at all.
 */
function logInitialize(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== "initialize") return;
  const { clientInfo, protocolVersion } = (params ?? {}) as {
    clientInfo?: { name?: unknown; version?: unknown };
    protocolVersion?: unknown;
  };
  logger.info("mcp.initialize", {
    client: typeof clientInfo?.name === "string" ? clientInfo.name : undefined,
    clientVersion:
      typeof clientInfo?.version === "string" ? clientInfo.version : undefined,
    protocolVersion:
      typeof protocolVersion === "string" ? protocolVersion : undefined,
  });
}

export function createFetchHandler(options: FetchHandlerOptions): FetchHandler {
  const oauthRouter = options.security.oauth
    ? createOAuthRouter({
        config: options.security.oauth,
        resolve: options.resolveClient,
      })
    : undefined;

  const mcp = createMcpHandler(() => createServer(), {
    legacy: "stateless",
    // Reporting only — the SDK has already shaped the response by the time
    // this fires, so a throw here could not change what the client sees. A
    // silent rejection would leave a half-migrated client indistinguishable
    // from an unreachable server, the same argument `security.rejected`
    // makes.
    onerror: (error) =>
      logger.warn("mcp.error", { reason: error.message, stack: error.stack }),
  });

  /**
   * Refuse a write the caller's token is not scoped for, as an HTTP status.
   *
   * Returns `undefined` when there is nothing to refuse, which covers the two
   * modes that hold every scope: an unauthenticated LAN server (where
   * `writeToolDisabled` gives the honest tool-level explanation instead) and the
   * legacy shared secret.
   */
  function checkScopes(body: unknown, grant: AuthGrant): Response | undefined {
    if (grant.scopes.includes(SCOPE_WRITE)) return undefined;
    const wanted = protectedToolsIn(body);
    if (wanted.length === 0) return undefined;
    const oauth = options.security.oauth;
    logger.warn("security.insufficient_scope", {
      held: [...grant.scopes],
      subject: grant.subject,
      tools: wanted,
    });
    return new Response(
      JSON.stringify({
        error: {
          code: -32000,
          message: `Forbidden: ${wanted.join(", ")} requires the ${SCOPE_WRITE} scope`,
        },
        id: null,
        jsonrpc: "2.0",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...(oauth
            ? { "WWW-Authenticate": insufficientScopeChallenge(oauth) }
            : {}),
        },
        status: 403,
      },
    );
  }

  async function handleMcp(req: Request, grant: AuthGrant): Promise<Response> {
    if (req.method !== "POST") {
      // GET (the 2025 standalone stream) and DELETE (session teardown) have
      // nothing to address on a stateless server; the SDK answers every
      // non-POST method 405, which the 2025 spec allows.
      return mcp.fetch(req);
    }

    // Parsed here, once, for three readers: the parse-error answer (unguarded,
    // a malformed body rejected out of the fetch handler), the scope gate, and
    // the SDK via `parsedBody` so the body is never read twice.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error: body is not valid JSON");
    }

    // Before the message reaches the SDK: past its dispatch the answer is
    // already destined to be a 200, and a 200 does not produce an auth
    // prompt. Runs on the parsed body, so it covers both eras without either
    // knowing about the gate.
    const insufficient = checkScopes(body, grant);
    if (insufficient) return insufficient;

    logInitialize(body);
    return mcp.fetch(req, { parsedBody: body });
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // Deliberately ahead of the security gate: the container's HEALTHCHECK
      // runs with no token and no Origin, and a liveness probe that needs a
      // credential is a liveness probe that reports the credential's health.
      if (url.pathname === "/health") {
        return Response.json(buildHealth());
      }

      // Ahead of the gate for the same reason `/health` is, and it is not a
      // hole: a document a client fetches *in order to* authenticate cannot
      // itself require authentication, and neither can the endpoints that mint
      // the token. `/oauth/authorize` carries its own gate — the owner
      // passphrase — and `/oauth/token` carries PKCE.
      const oauth = await oauthRouter?.handle(req, url.pathname);
      if (oauth) return oauth;

      if (url.pathname === "/mcp") {
        const preflight = handlePreflight(req, options.security);
        if (preflight) return preflight;

        // Authenticated once, here, and the result is used for both the gate
        // and the scope check below — rather than verifying the same token
        // twice on every call.
        const auth = await authenticate(req, options.security);
        const rejection = await checkRequest(req, options.security, auth);
        if (rejection) {
          // A silent rejection makes the two failures an operator actually
          // hits — a host whose Origin is not on the allowlist, and a token
          // that does not match — indistinguishable from the server being
          // unreachable. The status carries which one it was; 403 is Origin or
          // Host, 401 is the token.
          logger.warn("security.rejected", {
            // Whether a credential was presented at all, which is the one fact
            // that separates "the client never sent the token" from "the token
            // it sent was wrong". There is an open upstream report of Claude
            // completing authorization and then never sending the bearer
            // (anthropics/claude-ai-mcp#540) that nobody could evidence; if it
            // ever bites this server, this field is the evidence.
            hasAuthorization: req.headers.get("authorization") !== null,
            method: req.method,
            origin: req.headers.get("origin") ?? undefined,
            // The specific verification failure, which is deliberately not in
            // the response body — see `AuthOutcome.reason`.
            reason: auth.reason,
            status: rejection.status,
          });
          return rejection;
        }

        return withCors(
          await handleMcp(req, auth.grant),
          corsHeaders(req, options.security),
        );
      }

      return new Response("Not found", { status: 404 });
    },

    async shutdown() {
      await mcp.close();
    },
  };
}
