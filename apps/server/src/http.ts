import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type InitializeRequest,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { buildHealth } from "./health";
import { logger } from "./logging";
import {
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
import { createServer } from "./server";

/**
 * The HTTP surface, separated from `index.ts` so it can be exercised without
 * binding a port. `index.ts` is now only bootstrap — read the environment,
 * serve this handler, wire the signals — which is why it stays out of the
 * coverage set while everything it delegates to is covered.
 */

export interface FetchHandlerOptions {
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
 * `session.opened` used to carry only an opaque uuid, which answered none of
 * the questions an operator actually has when a host misbehaves: which client
 * is this, and is it re-handshaking on every turn or reusing a session? Both
 * are visible from the log now, and one line per turn from the same client name
 * is the signature of a host that has thrown its session away.
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

  async function handleMcp(req: Request): Promise<Response> {
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
        if (!(await sessions.tryReserve())) {
          return jsonRpcError(
            503,
            -32000,
            "Server at session capacity; retry shortly",
          );
        }
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

      if (url.pathname === "/mcp") {
        const preflight = handlePreflight(req, options.security);
        if (preflight) return preflight;

        const rejection = checkRequest(req, options.security);
        if (rejection) {
          // Rejections used to be silent, which made the two failures an
          // operator actually hits — a host whose Origin is not on the
          // allowlist, and a token that does not match — indistinguishable
          // from the server being unreachable. The status carries which one it
          // was; 403 is Origin or Host, 401 is the token.
          logger.warn("security.rejected", {
            method: req.method,
            origin: req.headers.get("origin") ?? undefined,
            status: rejection.status,
          });
          return rejection;
        }

        return withCors(
          await handleMcp(req),
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
