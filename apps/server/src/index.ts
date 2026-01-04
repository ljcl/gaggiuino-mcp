import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server";

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";

// Map of session ID -> transport
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function createTransport(): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      console.error(`Session initialized: ${sessionId}`);
      transports.set(sessionId, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      console.error(`Session closed: ${transport.sessionId}`);
      transports.delete(transport.sessionId);
    }
  };
  return transport;
}

async function handleMcp(req: Request): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");

  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return new Response("Invalid or missing session ID", { status: 400 });
    }
    return transport.handleRequest(req);
  }

  if (req.method === "POST") {
    const body = await req.json();

    // Reuse existing session
    if (sessionId) {
      const transport = transports.get(sessionId);
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
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response("Method not allowed", { status: 405 });
}

console.error("Starting Gaggiuino MCP server...");
console.error(
  `Connecting to: ${process.env.GAGGIUINO_URL ?? "http://gaggiuino.local"}`,
);

Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      return handleMcp(req);
    }

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
});

console.error(`Listening on http://${HOST}:${PORT}`);
console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.error("Shutting down...");
  for (const [id, transport] of transports) {
    console.error(`Closing session ${id}`);
    await transport.close();
  }
  process.exit(0);
});
