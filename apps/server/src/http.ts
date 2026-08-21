import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type InitializeRequest,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
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
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerOptions,
} from "./mcpSession";
import { handleModernRequest, isModernRequest } from "./modern";
import { insufficientScopeChallenge } from "./oauth/metadata";
import { createOAuthRouter, type OAuthRouterOptions } from "./oauth/router";
import { protectedToolsIn } from "./oauth/scopeGate";
import { SCOPE_WRITE } from "./oauth/scopes";
import { createServer } from "./server";

/**
 * The HTTP surface, separated from `index.ts` so it can be exercised without
 * binding a port. `index.ts` is now only bootstrap — read the environment,
 * serve this handler, wire the signals — which is why it stays out of the
 * coverage set while everything it delegates to is covered.
 */

export interface FetchHandlerOptions {
  /** Test seam for CIMD resolution, so no test reaches claude.ai. */
  resolveClient?: OAuthRouterOptions["resolve"];
  security: SecurityConfig;
  sessions?: SessionManagerOptions;
}

export interface FetchHandler {
  fetch(req: Request): Promise<Response>;
  /** Close every live session. Called on SIGTERM/SIGINT after the port stops. */
  shutdown(): Promise<void>;
  /** Start the idle-session reaper. Returns a function that stops it. */
  startReaper(): () => void;
  /** The live session registry, for assertions and shutdown. */
  readonly sessions: SessionManager<WebStandardStreamableHTTPServerTransport>;
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
 * A `Response` handed back by the transport is streaming, so this re-wraps the
 * same `ReadableStream` rather than reading it — an SSE stream must stay open.
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
 * Who opened a session, taken from the `initialize` request itself rather than
 * the server's later `oninitialized` callback, so it is known at the moment the
 * session id is minted.
 *
 * An opaque uuid alone answers neither question an operator actually has when
 * a host misbehaves: which client is this, and is it re-handshaking on every
 * turn or reusing a session? Both are visible from the log, and one
 * `session.opened` per turn from the same client name is the signature of a
 * host that has thrown its session away.
 */
function describeInitiator(body: InitializeRequest): Record<string, string> {
  const { clientInfo, protocolVersion } = body.params;
  return {
    client: clientInfo.name,
    clientVersion: clientInfo.version,
    protocolVersion,
  };
}

export function createFetchHandler(options: FetchHandlerOptions): FetchHandler {
  const oauthRouter = options.security.oauth
    ? createOAuthRouter({
        config: options.security.oauth,
        resolve: options.resolveClient,
      })
    : undefined;

  const sessions =
    createSessionManager<WebStandardStreamableHTTPServerTransport>({
      onEvicted: (sessionId, reason) =>
        logger.info("session.evicted", { reason, sessionId }),
      ...options.sessions,
    });

  function createTransport(
    initiator: Record<string, string>,
  ): WebStandardStreamableHTTPServerTransport {
    const transport = new WebStandardStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => {
        logger.info("session.opened", { ...initiator, sessionId });
        sessions.add(sessionId, transport);
      },
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        logger.info("session.closed", { sessionId: transport.sessionId });
        sessions.delete(transport.sessionId);
      }
    };
    return transport;
  }

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
    const sessionId = req.headers.get("mcp-session-id");

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) {
        return jsonRpcError(
          400,
          -32000,
          "Bad Request: Mcp-Session-Id header is required",
        );
      }
      const transport = sessions.get(sessionId);
      if (!transport) {
        // 404 is the spec's signal that a session id is not recognised, and it
        // is what tells a client to start a new one with `initialize`. This
        // used to answer 400 for an expired session as well as a missing
        // header, which reads as "your request is malformed" — a client that
        // believes that has no reason to re-handshake, so a session reclaimed
        // by the idle TTL stranded the client instead of prompting a reconnect.
        return jsonRpcError(
          404,
          -32000,
          "Session not found or expired; send initialize to start a new one",
        );
      }
      return transport.handleRequest(req);
    }

    if (req.method === "POST") {
      // Unguarded, this rejected out of the fetch handler on any malformed
      // body — an unhandled rejection from anything that could reach the port.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonRpcError(400, -32700, "Parse error: body is not valid JSON");
      }

      // Before the message reaches the SDK, and before a session is reserved:
      // past `transport.handleRequest` the answer is already destined to be a
      // 200, and a 200 does not produce an auth prompt. It runs before the era
      // split below so the modern era inherits the gate rather than
      // reimplementing it — `protectedToolsIn` reads the same body shape in
      // both eras.
      const insufficient = checkScopes(body, grant);
      if (insufficient) return insufficient;

      // The dual-era split, keyed on the request per the 2026-07-28 versioning
      // spec: a request carrying modern per-request `_meta` is served
      // statelessly, and an `initialize` selects the legacy session flow
      // below. Checked ahead of the session branch because a modern request
      // must be served even when a stale `Mcp-Session-Id` header rides along —
      // the modern transport says to ignore that header, not to 404 on it.
      if (isModernRequest(req, body)) {
        return handleModernRequest(req, body);
      }

      // Reuse existing session
      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (!transport) {
          return jsonRpcError(
            404,
            -32000,
            "Session not found or expired; send initialize to start a new one",
          );
        }
        return transport.handleRequest(req, { parsedBody: body });
      }

      // New session — must be an initialize request
      if (isInitializeRequest(body)) {
        // Never refuses. The cap bounds how many transports are held, not how
        // long a conversation may run: a host that opens a session per tool
        // call and never DELETEs would otherwise hit a 503 mid-conversation,
        // and retrying that 503 is another initialize. Whatever gets closed
        // here answers 404 next, which is the spec's re-handshake signal.
        await sessions.reserve();
        const transport = createTransport(describeInitiator(body));
        const server = createServer();
        await server.connect(transport);
        return transport.handleRequest(req, { parsedBody: body });
      }

      return jsonRpcError(400, -32000, "Bad Request: No valid session ID");
    }

    return new Response("Method not allowed", { status: 405 });
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

    sessions,

    async shutdown() {
      await sessions.closeAll();
    },

    startReaper: sessions.startReaper,
  };
}
