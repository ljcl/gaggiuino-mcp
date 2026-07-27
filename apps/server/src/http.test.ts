import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFetchHandler, type FetchHandler } from "./http";
import { type SecurityConfig } from "./mcpAuth";

/**
 * These drive the real fetch handler with real `Request` objects instead of
 * binding a port, so the routing, the security gate, and the transport
 * handshake are all in the loop. The one thing not covered here is `index.ts`
 * itself, which after the extraction is only environment reads and
 * `Bun.serve`.
 */

const TOKEN = "correct-horse-battery-staple";

const GATED: SecurityConfig = {
  allowedHosts: [],
  allowedOrigins: [],
  token: TOKEN,
};

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

let handler: FetchHandler;

function initializeBody(): string {
  return JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
      protocolVersion: "2025-06-18",
    },
  });
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8000/mcp", {
    body,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

function authorized(
  headers: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...headers };
}

beforeEach(() => {
  handler = createFetchHandler({ security: GATED });
});

afterEach(async () => {
  await handler.shutdown();
});

describe("/health", () => {
  it("answers without a token even when /mcp is gated", async () => {
    // The container HEALTHCHECK has no credential. A liveness probe that needs
    // one reports the credential's health, not the process's.
    const response = await handler.fetch(
      new Request("http://localhost:8000/health"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("stays reachable from a disallowed origin", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/health", {
        headers: { origin: "https://evil.test" },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("/mcp security gate", () => {
  it("rejects an unauthenticated initialize with 401 and a challenge", async () => {
    const response = await handler.fetch(post(initializeBody()));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    // Nothing was allocated for a request that never got past the gate.
    expect(handler.sessions.size).toBe(0);
  });

  it("rejects a browser origin with 403 before touching the transport", async () => {
    const response = await handler.fetch(
      post(initializeBody(), authorized({ origin: "https://evil.test" })),
    );
    expect(response.status).toBe(403);
    expect(handler.sessions.size).toBe(0);
  });

  it("completes the handshake and registers a session with a valid token", async () => {
    const response = await handler.fetch(post(initializeBody(), authorized()));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(handler.sessions.size).toBe(1);
  });

  it("serves an unauthenticated deployment when no token is configured", async () => {
    handler = createFetchHandler({ security: OPEN });
    const response = await handler.fetch(post(initializeBody()));
    expect(response.status).toBe(200);
  });
});

describe("/mcp routing", () => {
  it("rejects a POST that is neither initialize nor a known session", async () => {
    const response = await handler.fetch(
      post(
        JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        authorized(),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a POST naming a session that does not exist", async () => {
    const response = await handler.fetch(
      post(
        JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        authorized({ "mcp-session-id": "not-a-session" }),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("rejects a GET with no session id", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: authorized({ accept: "text/event-stream" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("closes a session on DELETE and drops it from the map", async () => {
    const init = await handler.fetch(post(initializeBody(), authorized()));
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    expect(handler.sessions.size).toBe(1);

    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: authorized({ "mcp-session-id": sessionId }),
        method: "DELETE",
      }),
    );
    expect(response.status).toBeLessThan(300);
    expect(handler.sessions.size).toBe(0);
  });

  it("answers an unsupported method with 405", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: authorized(),
        method: "PUT",
      }),
    );
    expect(response.status).toBe(405);
  });

  it("answers a malformed body with a JSON-RPC parse error", async () => {
    // Unguarded this rejected out of the fetch handler — an unhandled
    // rejection from anything that could reach the port.
    const response = await handler.fetch(post("{not json", authorized()));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe("session capacity", () => {
  it("refuses a new session with 503 once the cap is reached", async () => {
    handler = createFetchHandler({
      security: GATED,
      sessions: { maxSessions: 1 },
    });
    const first = await handler.fetch(post(initializeBody(), authorized()));
    expect(first.status).toBe(200);

    const second = await handler.fetch(post(initializeBody(), authorized()));
    expect(second.status).toBe(503);
    const body = (await second.json()) as { error: { message: string } };
    expect(body.error.message).toContain("capacity");
    expect(handler.sessions.size).toBe(1);
  });

  it("admits a new session once an abandoned one ages out", async () => {
    // The leak this bounds is a client that vanishes without a DELETE: a
    // dropped tunnel, a restarted host. Its session must not hold a slot
    // forever.
    let now = 1_000_000;
    handler = createFetchHandler({
      security: GATED,
      sessions: { idleTimeoutMs: 1_000, maxSessions: 1, now: () => now },
    });
    await handler.fetch(post(initializeBody(), authorized()));
    expect(handler.sessions.size).toBe(1);

    now += 2_000;
    const second = await handler.fetch(post(initializeBody(), authorized()));
    expect(second.status).toBe(200);
    expect(handler.sessions.size).toBe(1);
  });
});

describe("shutdown", () => {
  it("closes every live session", async () => {
    await handler.fetch(post(initializeBody(), authorized()));
    expect(handler.sessions.size).toBe(1);
    await handler.shutdown();
    expect(handler.sessions.size).toBe(0);
  });
});

describe("unknown routes", () => {
  it("404s without consulting the security gate", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/nope"),
    );
    expect(response.status).toBe(404);
  });
});
