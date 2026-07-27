import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkRequest, type SecurityConfig } from "./mcpAuth";
import { createServer } from "./server";

/**
 * The HTTP surface, separated from `index.ts` so it can be exercised without
 * binding a port. `index.ts` is now only bootstrap — read the environment,
 * serve this handler, wire the signals — which is why it stays out of the
 * coverage set while everything it delegates to is covered.
 */

export interface FetchHandlerOptions {
  security: SecurityConfig;
}

export interface FetchHandler {
  /** Live transports keyed by session id. Exposed for shutdown draining. */
  readonly sessions: Map<string, WebStandardStreamableHTTPServerTransport>;
  fetch(req: Request): Promise<Response>;
}

export function createFetchHandler(options: FetchHandlerOptions): FetchHandler {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  function createTransport(): WebStandardStreamableHTTPServerTransport {
    const transport = new WebStandardStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => {
        console.error(`Session initialized: ${sessionId}`);
        sessions.set(sessionId, transport);
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
      const body = await req.json();

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
        const transport = createTransport();
        const server = createServer();
        await server.connect(transport);
        return transport.handleRequest(req, { parsedBody: body });
      }

      return new Response(
        JSON.stringify({
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
          jsonrpc: "2.0",
        }),
        { headers: { "Content-Type": "application/json" }, status: 400 },
      );
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
  };
}
