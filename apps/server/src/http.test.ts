import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, resetClient } from "./client";
import { createFetchHandler, type FetchHandler } from "./http";
import { setLogLevel } from "./logging";
import { type SecurityConfig } from "./mcpAuth";
import { mockServer } from "./test-setup";
import { SERVER_VERSION } from "./version";

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
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      machine: { state: string; url: string };
      status: string;
      uptimeSec: number;
      version: string;
    };
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.machine.url).toBeTruthy();
    expect(body.machine.state).toBeTruthy();
  });

  it("stays 200 while the machine is unreachable", async () => {
    // The espresso machine is off most of the day. Failing the healthcheck for
    // that would restart a perfectly healthy container every afternoon.
    resetClient({ initialDelayMs: 1, maxRetries: 1 });
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.error(),
      ),
    );
    await expect(getClient().getStatus()).rejects.toThrow();

    const response = await handler.fetch(
      new Request("http://localhost:8000/health"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { machine: { state: string } };
    expect(body.machine.state).toBe("unreachable");
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

  it("answers a GET naming an expired session with 404, not 400", async () => {
    // 404 is the spec's signal that a session id is not recognised, and it is
    // what tells a client to re-handshake. This used to answer 400 — "your
    // request is malformed" — which no client recovers from by sending
    // initialize, so a session reclaimed by the idle TTL stranded its client.
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: authorized({
          accept: "text/event-stream",
          "mcp-session-id": "reclaimed-by-the-reaper",
        }),
      }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("initialize");
  });

  it("answers a DELETE naming an expired session with 404", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: authorized({ "mcp-session-id": "already-gone" }),
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(404);
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

describe("browser origins", () => {
  const BROWSER: SecurityConfig = {
    allowedHosts: [],
    allowedOrigins: ["https://claude.ai"],
    token: TOKEN,
  };

  beforeEach(() => {
    handler = createFetchHandler({ security: BROWSER });
  });

  it("answers the preflight the browser sends before the real request", async () => {
    // Without this the endpoint answered OPTIONS with 405 and no CORS headers,
    // so `MCP_ALLOWED_ORIGINS` allowed an origin that could still never reach
    // the server — the preflight failed before the POST was attempted.
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: {
          "access-control-request-method": "POST",
          origin: "https://claude.ai",
        },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://claude.ai",
    );
  });

  it("lets an allowed origin read the handshake response", async () => {
    const response = await handler.fetch(
      post(initializeBody(), authorized({ origin: "https://claude.ai" })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://claude.ai",
    );
    // The session id is not CORS-safelisted; unexposed, the client has no
    // session to continue with even though the handshake succeeded.
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "mcp-session-id",
    );
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("adds no CORS headers for a client that sent no Origin", async () => {
    const response = await handler.fetch(post(initializeBody(), authorized()));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });

  it("still refuses a preflight from an origin outside the allowlist", async () => {
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: { origin: "https://evil.test" },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });
});

describe("tools/list over the real transport", () => {
  /**
   * The in-memory tests in `server.test.ts` assert what the handlers return.
   * This asserts what actually crosses the wire, because the parts a host keys
   * a permission grant to — `annotations` and `_meta` — are exactly the parts a
   * transport or SDK version is free to drop on the way out. A tool that
   * arrives without `readOnlyHint` is read as write/destructive and prompts on
   * every call however the connector is configured, and nothing upstream of
   * here would have told us.
   */
  async function listTools(): Promise<Tool[]> {
    const init = await handler.fetch(post(initializeBody(), authorized()));
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    const response = await handler.fetch(
      post(
        JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
        authorized({ "mcp-session-id": sessionId }),
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    // The transport answers on an SSE stream unless it has a reason not to, so
    // take the payload from whichever framing came back.
    const payload = body.startsWith("{")
      ? body
      : (body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim() ?? "");
    const message = JSON.parse(payload) as { result: { tools: Tool[] } };
    return message.result.tools;
  }

  it("serves every tool with its annotations intact", async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: tool.name !== "select_profile",
      });
    }
  });

  it("does not lose the write hint in transit", async () => {
    // `annotations` is exactly the field an SDK or transport version is free
    // to drop, and a write tool arriving without readOnlyHint: false reads as
    // just another read — no prompt before the machine changes.
    const tools = await listTools();
    const write = tools.find((tool) => tool.name === "select_profile");
    expect(write?.annotations?.readOnlyHint).toBe(false);
  });

  it("serves the MCP App wiring intact", async () => {
    const tools = await listTools();
    const graph = tools.find((tool) => tool.name === "view_shot_graph");
    expect(graph?._meta).toEqual({
      ui: { resourceUri: "ui://shot-graph/app.html" },
    });
  });
});

describe("session logging", () => {
  it("records which client opened the session", async () => {
    // An opaque uuid answered neither question an operator has when a host
    // re-prompts: which client is this, and is it re-handshaking every turn?
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    setLogLevel("info");
    try {
      await handler.fetch(post(initializeBody(), authorized()));
    } finally {
      spy.mockRestore();
      setLogLevel("silent");
    }
    expect(
      records.find((entry) => entry.event === "session.opened"),
    ).toMatchObject({
      client: "test",
      clientVersion: "1.0",
      protocolVersion: "2025-06-18",
    });
  });
});

describe("rejection logging", () => {
  it("records why the gate refused a request", async () => {
    // Silent rejections made the two failures an operator actually hits — an
    // Origin off the allowlist and a token that does not match — look
    // identical to the server being unreachable.
    // Captures the real sink so the default `console.error` path stays in the
    // loop, as the tool-call logging tests do.
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    setLogLevel("warn");
    try {
      await handler.fetch(
        post(initializeBody(), { origin: "https://evil.test" }),
      );
    } finally {
      spy.mockRestore();
      setLogLevel("silent");
    }
    const record = records.find((entry) => entry.event === "security.rejected");
    expect(record).toMatchObject({
      origin: "https://evil.test",
      status: 403,
    });
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
