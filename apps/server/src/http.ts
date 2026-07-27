import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkRequest, type SecurityConfig } from "./mcpAuth";
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

export function createFetchHandler(options: FetchHandlerOptions): FetchHandler {
  const sessions =
    createSessionManager<WebStandardStreamableHTTPServerTransport>({
      onEvicted: (sessionId, reason) =>
        console.error(`Session evicted (${reason}): ${sessionId}`),
      ...options.sessions,
    });

  function createTransport(): WebStandardStreamableHTTPServerTransport {
    const transport = new WebStandardStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => {
        console.error(`Session initialized: ${sessionId}`);
        sessions.add(sessionId, transport);
      },
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        console.error(`Session closed: ${transport.sessionId}`);
        sessions.delete(transport.sessionId);
      }
    };
    return transport;
  }

  async function handleMcp(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        return new Response("Invalid or missing session ID", { status: 400 });
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
          return new Response("Invalid session ID", { status: 404 });
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
        const transport = createTransport();
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
        return new Response("ok");
      }

      if (url.pathname === "/mcp") {
        const rejection = checkRequest(req, options.security);
        if (rejection) return rejection;
        return handleMcp(req);
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
