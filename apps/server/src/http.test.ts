import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, resetClient } from "./client";
import { createFetchHandler, type FetchHandler } from "./http";
import { setLogLevel } from "./logging";
import { type SecurityConfig } from "./mcpAuth";
import { TEST_OAUTH_CONFIG, TEST_PASSPHRASE_HASH } from "./oauth/__fixtures__";
import { ALL_SCOPES_HEADER } from "./oauth/scopes";
import { signToken } from "./oauth/tokens";
import { mockServer } from "./test-setup";
import { SERVER_VERSION } from "./version";

/**
 * These drive the real fetch handler with real `Request` objects instead of
 * binding a port, so the routing, the security gate, and the transport
 * handshake are all in the loop. The one thing not covered here is `index.ts`
 * itself, which after the extraction is only environment reads and
 * `Bun.serve`.
 */

const ISSUER = "https://box.tail1234.ts.net";
const RESOURCE = `${ISSUER}/mcp`;
const SECRET = "s".repeat(64);

/** Mint an access token this server will accept, scoped as asked. */
function accessToken(scope: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signToken(
    {
      aud: RESOURCE,
      exp: issuedAt + 3600,
      iat: issuedAt,
      iss: ISSUER,
      jti: "id",
      scope,
      sub: "owner",
    },
    SECRET,
    "access-token",
  );
}

const GATED: SecurityConfig = {
  allowedHosts: [],
  allowedOrigins: [],
  oauth: TEST_OAUTH_CONFIG,
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
  return {
    authorization: `Bearer ${accessToken(ALL_SCOPES_HEADER)}`,
    ...headers,
  };
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
  it("admits a new session at the cap by evicting, never by refusing", async () => {
    // #122: Claude opens a session per tool call and never DELETEs, so at the
    // cap a 503 would end a working conversation — and its "retry shortly" is
    // another initialize, which is what filled the map.
    handler = createFetchHandler({
      security: GATED,
      sessions: { maxSessions: 1 },
    });
    const first = await handler.fetch(post(initializeBody(), authorized()));
    expect(first.status).toBe(200);
    const evicted = first.headers.get("mcp-session-id");

    const second = await handler.fetch(post(initializeBody(), authorized()));
    expect(second.status).toBe(200);
    expect(handler.sessions.size).toBe(1);
    expect(second.headers.get("mcp-session-id")).not.toBe(evicted);
  });

  it("answers the evicted session's next request with 404, not 400", async () => {
    // The eviction is only survivable because of this: 404 is the Streamable
    // HTTP signal to re-handshake, so a client whose slot was taken recovers
    // on its own. 400 would strand it.
    handler = createFetchHandler({
      security: GATED,
      sessions: { maxSessions: 1 },
    });
    const first = await handler.fetch(post(initializeBody(), authorized()));
    const evicted = first.headers.get("mcp-session-id") ?? "";
    await handler.fetch(post(initializeBody(), authorized()));

    const stranded = await handler.fetch(
      post(
        JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
        authorized({ "mcp-session-id": evicted }),
      ),
    );
    expect(stranded.status).toBe(404);
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
    ...GATED,
    allowedOrigins: ["https://claude.ai"],
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

  /** Duplicated from `server.test.ts` on purpose — this file asserts the same
   *  facts over the real transport, and sharing the sets would let one edit
   *  satisfy both assertions. */
  const WRITE_TOOLS = new Set([
    "delete_profile",
    "select_profile",
    "upload_profile",
  ]);
  const NON_IDEMPOTENT_TOOLS = new Set(["upload_profile"]);
  const IDEMPOTENCE_UNSTATED = new Set(["delete_profile"]);
  const DESTRUCTIVE_TOOLS = new Set(["delete_profile"]);
  const ALWAYS_PROMPT_TOOLS = new Set(["delete_profile"]);

  it("serves every tool with its annotations intact", async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
        readOnlyHint: !WRITE_TOOLS.has(tool.name),
      });
      // Separate from the toMatchObject above because the assertion is about a
      // key being *absent*, which toMatchObject cannot express.
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotent`).toBe(
        IDEMPOTENCE_UNSTATED.has(tool.name)
          ? undefined
          : !NON_IDEMPOTENT_TOOLS.has(tool.name),
      );
    }
  });

  it("does not lose the destructive hint in transit", async () => {
    // The same exposure as the two below, on the flag with the worst downside:
    // a delete tool arriving without destructiveHint reads as an ordinary
    // write, and the host stops warning before something irreversible.
    const tools = await listTools();
    const remove = tools.find((tool) => tool.name === "delete_profile");
    expect(remove?.annotations?.destructiveHint).toBe(true);
  });

  it("does not lose the always-prompt flag in transit", async () => {
    // `_meta` is as droppable as `annotations`, and this flag is the only thing
    // stopping a stored allow rule from letting a delete through unprompted.
    const tools = await listTools();
    for (const tool of tools) {
      const meta = (tool._meta ?? {}) as Record<string, unknown>;
      expect(
        meta["anthropic/requiresUserInteraction"],
        `${tool.name} requiresUserInteraction`,
      ).toBe(ALWAYS_PROMPT_TOOLS.has(tool.name) ? true : undefined);
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

  it("does not lose the non-idempotent hint in transit", async () => {
    // The same exposure, one flag over: a host that sees idempotentHint true
    // feels free to retry, and a retried upload creates a second profile.
    const tools = await listTools();
    const upload = tools.find((tool) => tool.name === "upload_profile");
    expect(upload?.annotations?.idempotentHint).toBe(false);
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

describe("OAuth", () => {
  // The same config the rest of this file drives through `GATED`, named
  // locally because these tests are about the gate itself rather than about
  // what sits behind it.
  const OAUTH = GATED;

  let oauthHandler: FetchHandler;

  function bearer(scope: string): Record<string, string> {
    return { authorization: `Bearer ${accessToken(scope)}` };
  }

  function get(path: string): Request {
    return new Request(`http://localhost:8000${path}`);
  }

  /** The `result` of a tool call, taken from whichever framing came back. */
  async function readResult(
    response: Response,
  ): Promise<{ isError?: boolean }> {
    const body = await response.text();
    const payload = body.startsWith("{")
      ? body
      : (body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim() ?? "");
    return (JSON.parse(payload) as { result: { isError?: boolean } }).result;
  }

  beforeEach(() => {
    oauthHandler = createFetchHandler({ security: OAUTH });
  });

  afterEach(async () => {
    await oauthHandler.shutdown();
  });

  describe("discovery", () => {
    it("serves both well-known documents with no credential", async () => {
      // A document a client fetches *in order to* authenticate cannot itself
      // require authentication — the same reason `/health` is routed early.
      for (const path of [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
      ]) {
        const response = await oauthHandler.fetch(get(path));
        expect(response.status, path).toBe(200);
        expect(await response.json()).toMatchObject({ resource: RESOURCE });
      }
    });

    it("does not mount the routes while OAuth is unconfigured", async () => {
      // A LAN install that never configures OAuth is unchanged by all of this:
      // the documents are not served at all rather than served empty. The
      // outer `afterEach` shuts this handler down.
      handler = createFetchHandler({ security: OPEN });
      const response = await handler.fetch(
        get("/.well-known/oauth-protected-resource"),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("the 401", () => {
    it("is a 401 carrying a pointer to the metadata", async () => {
      // Claude does not honour a `WWW-Authenticate` on a 200, and with no
      // pointer it never learns where the authorization server is.
      const response = await oauthHandler.fetch(post(initializeBody()));
      expect(response.status).toBe(401);
      const challenge = response.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain(
        `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(challenge).toContain('scope="espresso:read espresso:write"');
    });

    it("refuses a token minted for a different resource", async () => {
      const foreign = signToken(
        {
          aud: "https://someone-else.ts.net/mcp",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          iss: ISSUER,
          jti: "id",
          scope: "espresso:read espresso:write",
          sub: "owner",
        },
        SECRET,
        "access-token",
      );
      const response = await oauthHandler.fetch(
        post(initializeBody(), { authorization: `Bearer ${foreign}` }),
      );
      expect(response.status).toBe(401);
    });

    it("logs whether a credential was presented at all", async () => {
      // The field an upstream report of "Claude authorizes then never sends the
      // bearer" could not produce. If it ever bites us, this is the evidence.
      const records: Array<Record<string, unknown>> = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((line: unknown) => {
          records.push(JSON.parse(String(line)) as Record<string, unknown>);
        });
      setLogLevel("warn");
      try {
        await oauthHandler.fetch(post(initializeBody()));
        await oauthHandler.fetch(
          post(initializeBody(), { authorization: "Bearer nonsense" }),
        );
      } finally {
        setLogLevel("silent");
        spy.mockRestore();
      }
      const rejected = records.filter(
        (entry) => entry.event === "security.rejected",
      );
      expect(rejected).toHaveLength(2);
      expect(rejected[0]).toMatchObject({
        hasAuthorization: false,
        reason: "missing",
        status: 401,
      });
      expect(rejected[1]).toMatchObject({
        hasAuthorization: true,
        // "nonsense" is one segment, so it never reaches the signature check.
        reason: "malformed",
      });
    });
  });

  describe("the scope step-up", () => {
    async function callTool(name: string, scope: string): Promise<Response> {
      const init = await oauthHandler.fetch(
        post(initializeBody(), bearer(scope)),
      );
      const sessionId = init.headers.get("mcp-session-id") ?? "";
      return oauthHandler.fetch(
        post(
          JSON.stringify({
            id: 2,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: {}, name },
          }),
          { ...bearer(scope), "mcp-session-id": sessionId },
        ),
      );
    }

    it("403s a write tool when the token lacks espresso:write", async () => {
      const response = await callTool("select_profile", "espresso:read");
      expect(response.status).toBe(403);
      const challenge = response.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain('error="insufficient_scope"');
      // Both scopes, not just the missing one — an earlier step-up's scopes are
      // not reliably carried forward, and this value is cached for ~15 minutes.
      expect(challenge).toContain('scope="espresso:read espresso:write"');
    });

    it("lets a read tool through on a read-only token", async () => {
      const response = await callTool("get_dial_in_guidance", "espresso:read");
      expect(response.status).toBe(200);
    });

    it("refuses before the machine is contacted", async () => {
      // The ESP32 constraint, asserted rather than assumed: a refused call must
      // cost the machine nothing. msw's `onUnhandledRequest: "error"` would
      // already fail this, but the count says so explicitly.
      let upstream = 0;
      mockServer.use(
        http.get("http://gaggiuino.local/*", () => {
          upstream += 1;
          return HttpResponse.json({});
        }),
        http.post("http://gaggiuino.local/*", () => {
          upstream += 1;
          return HttpResponse.text("OK");
        }),
      );
      resetClient();

      await oauthHandler.fetch(post(initializeBody()));
      await oauthHandler.fetch(
        post(initializeBody(), { authorization: "Bearer nonsense" }),
      );
      const refused = await callTool("select_profile", "espresso:read");

      expect(refused.status).toBe(403);
      expect(upstream).toBe(0);
    });
  });

  describe("a fully scoped token", () => {
    // `writeToolDisabled` reads `process.env` directly rather than the injected
    // `SecurityConfig` — in the running server those are the same source, but a
    // test that only injects the config leaves the tool believing nothing is
    // configured. Stubbing the environment is what makes this test model
    // production rather than the harness.
    beforeEach(() => {
      vi.stubEnv("MCP_PUBLIC_URL", ISSUER);
      vi.stubEnv("MCP_OAUTH_SECRET", SECRET);
      vi.stubEnv("MCP_OAUTH_PASSPHRASE_HASH", TEST_PASSPHRASE_HASH);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reaches the tool, which then reaches the machine", async () => {
      const selected: string[] = [];
      mockServer.use(
        http.get("http://gaggiuino.local/api/profiles/all", () =>
          HttpResponse.json([{ id: "15", name: "Zer0" }]),
        ),
        http.post(
          "http://gaggiuino.local/api/profile-select/:id",
          ({ params }) => {
            selected.push(String(params.id));
            return HttpResponse.text("OK");
          },
        ),
      );
      resetClient();

      const init = await oauthHandler.fetch(
        post(initializeBody(), bearer("espresso:read espresso:write")),
      );
      const sessionId = init.headers.get("mcp-session-id") ?? "";
      const response = await oauthHandler.fetch(
        post(
          JSON.stringify({
            id: 2,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              arguments: { profile_id: "zer0" },
              name: "select_profile",
            },
          }),
          {
            ...bearer("espresso:read espresso:write"),
            "mcp-session-id": sessionId,
          },
        ),
      );

      expect(response.status).toBe(200);
      // The body has to be read before the side effect is asserted: the
      // transport answers on an SSE stream, so the handler has not necessarily
      // run to completion until the stream is drained.
      const result = await readResult(response);
      expect(result.isError).toBeFalsy();
      expect(selected).toEqual(["15"]);
    });
  });
});
