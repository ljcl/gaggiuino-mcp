import { type Tool } from "@modelcontextprotocol/server";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, resetClient } from "./client";
import { createFetchHandler, type FetchHandler } from "./http";
import { setLogLevel } from "./logging";
import { type SecurityConfig } from "./mcpAuth";
import { PROTOCOL_VERSION } from "./mcpTestClient";
import { TEST_OAUTH_CONFIG, TEST_PASSPHRASE_HASH } from "./oauth/__fixtures__";
import { ALL_SCOPES_HEADER } from "./oauth/scopes";
import { signToken } from "./oauth/tokens";
import { mockServer } from "./test-setup";
import { SERVER_VERSION } from "./version";

/**
 * These drive the real fetch handler with real `Request` objects instead of
 * binding a port, so the routing, the security gate, and the transport are
 * all in the loop. The one thing not covered here is `index.ts`
 * itself: only environment reads and `Bun.serve`.
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

/** A 2025-era `initialize`, which this server now refuses. */
function legacyInitializeBody(): string {
  return JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "legacy-host", version: "0.9" },
      protocolVersion: "2025-06-18",
    },
  });
}

/**
 * One well-formed 2026-07-28 request: the `_meta` envelope in the body, and
 * the `Mcp-Method` / `Mcp-Name` headers that mirror it.
 */
function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  const mirrored: Record<string, string> = {
    "mcp-method": method,
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (typeof params.name === "string") mirrored["mcp-name"] = params.name;
  return post(
    JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "http-test",
            version: "1.0",
          },
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        },
      },
    }),
    { ...mirrored, ...headers },
  );
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
  it("rejects an unauthenticated request with 401 and a challenge", async () => {
    const response = await handler.fetch(rpc("tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a browser origin with 403 before touching the handler", async () => {
    const response = await handler.fetch(
      rpc("tools/list", {}, authorized({ origin: "https://evil.test" })),
    );
    expect(response.status).toBe(403);
  });

  it("serves a request with a valid token, minting no session", async () => {
    // The 2026-07-28 revision removed protocol sessions and the
    // `Mcp-Session-Id` header with them.
    const response = await handler.fetch(rpc("tools/list", {}, authorized()));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("serves an unauthenticated deployment when no token is configured", async () => {
    handler = createFetchHandler({ security: OPEN });
    const response = await handler.fetch(rpc("tools/list"));
    expect(response.status).toBe(200);
  });

  it("checks the token before it refuses a 2025-era request", async () => {
    // The era refusal belongs to the SDK, behind the gate: an unauthenticated
    // prober learns nothing about which revision this server speaks.
    const response = await handler.fetch(post(legacyInitializeBody()));
    expect(response.status).toBe(401);
  });
});

describe("/mcp routing", () => {
  it("answers the 2025 session operations (GET and DELETE) with 405", async () => {
    // The 2026-07-28 revision has no standalone stream to open and no session
    // to delete.
    for (const method of ["GET", "DELETE"]) {
      const response = await handler.fetch(
        new Request("http://localhost:8000/mcp", {
          headers: authorized({ accept: "text/event-stream" }),
          method,
        }),
      );
      expect(response.status, method).toBe(405);
    }
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

describe("2025-era clients", () => {
  /** The JSON-RPC error of a refused request. */
  async function readError(
    response: Response,
  ): Promise<{ code: number; data?: unknown; message: string }> {
    const body = (await response.json()) as {
      error: { code: number; data?: unknown; message: string };
    };
    return body.error;
  }

  it("refuses an initialize with -32022, naming the revision to use", async () => {
    // The documented answer for a client that has not moved on: HTTP 400 and
    // UnsupportedProtocolVersion, whose `supported` list is what the client
    // needs to fall forward.
    const response = await handler.fetch(
      post(legacyInitializeBody(), authorized()),
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32022);
    expect(error.data).toEqual({
      requested: "2025-06-18",
      supported: [PROTOCOL_VERSION],
    });
  });

  it("refuses a tools/call with no envelope, whatever its headers say", async () => {
    // The downgrade path this closes: with a legacy fallback, a request with
    // no envelope skipped the Mcp-Name check, so a proxy rule keyed on that
    // header could be walked past by naming a harmless tool in the header and
    // a different one in the body. The call must never reach the machine.
    let upstream = 0;
    mockServer.use(
      http.get("http://gaggiuino.local/*", () => {
        upstream += 1;
        return HttpResponse.json({});
      }),
    );
    resetClient();
    const response = await handler.fetch(
      post(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "get_status" },
        }),
        authorized({
          "mcp-method": "tools/call",
          "mcp-name": "get_dial_in_guidance",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32022);
    expect(upstream).toBe(0);
  });

  it("acknowledges a 2025-era notification and drops it", async () => {
    const response = await handler.fetch(
      post(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        authorized(),
      ),
    );
    expect(response.status).toBe(202);
  });

  it("refuses a JSON-RPC batch", async () => {
    // Batches belong to the 2025-03-26 family; the 2026-07-28 body is one
    // request.
    const response = await handler.fetch(
      post(
        JSON.stringify([{ id: 1, jsonrpc: "2.0", method: "tools/list" }]),
        authorized(),
      ),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32600);
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

  it("lets an allowed origin read the response", async () => {
    const response = await handler.fetch(
      rpc("tools/list", {}, authorized({ origin: "https://claude.ai" })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://claude.ai",
    );
  });

  it("adds no CORS headers for a client that sent no Origin", async () => {
    const response = await handler.fetch(rpc("tools/list", {}, authorized()));
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
    const response = await handler.fetch(rpc("tools/list", {}, authorized()));
    expect(response.status).toBe(200);
    // A list result is a single JSON body; the transport only upgrades to
    // SSE when a handler emits a notification before its result.
    expect(response.headers.get("content-type")).toContain("application/json");
    const message = (await response.json()) as { result: { tools: Tool[] } };
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

describe("refused-client logging", () => {
  function captureLogs() {
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    setLogLevel("info");
    return {
      records,
      restore: () => {
        spy.mockRestore();
        setLogLevel("silent");
      },
    };
  }

  it("names the 2025-era client it refused, and at which revision", async () => {
    // When a host stops working after an upgrade, this is the record that
    // says the host still speaks the old revision — `mcp.error` records the
    // refusal but not who sent it.
    const { records, restore } = captureLogs();
    try {
      await handler.fetch(
        post(
          legacyInitializeBody(),
          authorized({ "user-agent": "legacy/0.9" }),
        ),
      );
    } finally {
      restore();
    }
    expect(
      records.find((entry) => entry.event === "mcp.legacy_refused"),
    ).toMatchObject({
      client: "legacy-host",
      clientVersion: "0.9",
      protocolVersion: "2025-06-18",
      userAgent: "legacy/0.9",
    });
    // The SDK's own record of the same refusal, through `onerror`.
    expect(
      String(records.find((entry) => entry.event === "mcp.error")?.reason),
    ).toContain("2025-era");
  });

  it("still records an initialize whose params carry no client identity", async () => {
    // clientInfo is the client's own claim; a broken client that omits it
    // must not crash the log line that exists to diagnose broken clients.
    const { records, restore } = captureLogs();
    try {
      await handler.fetch(
        post(
          JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
          authorized(),
        ),
      );
    } finally {
      restore();
    }
    expect(
      records.find((entry) => entry.event === "mcp.legacy_refused"),
    ).toBeTruthy();
  });

  it("names no client for a 2025-era request that is not an initialize", async () => {
    // Only `initialize` carries the client's identity in the old revision.
    const { records, restore } = captureLogs();
    try {
      await handler.fetch(
        post(
          JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
          authorized(),
        ),
      );
    } finally {
      restore();
    }
    expect(
      records.find((entry) => entry.event === "mcp.legacy_refused"),
    ).toBeUndefined();
  });

  it("names no client for a 2026-07-28 request", async () => {
    // Classified by the SDK's own routing predicate, so a modern request that
    // happens to name `initialize` is not reported as a refused legacy one.
    const { records, restore } = captureLogs();
    try {
      await handler.fetch(rpc("initialize", {}, authorized()));
    } finally {
      restore();
    }
    expect(
      records.find((entry) => entry.event === "mcp.legacy_refused"),
    ).toBeUndefined();
  });

  it("passes a JSON body that is not an object through without logging", async () => {
    // `null` parses fine; the SDK answers it as the malformed message it is.
    const response = await handler.fetch(post("null", authorized()));
    expect(response.status).toBeGreaterThanOrEqual(400);
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
        rpc("tools/list", {}, { origin: "https://evil.test" }),
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
  it("resolves with nothing in flight", async () => {
    // There are no sessions to drain; close aborts in-flight exchanges and
    // resolves.
    await handler
      .fetch(rpc("tools/list", {}, authorized()))
      .then((response) => response.text());
    await expect(handler.shutdown()).resolves.toBeUndefined();
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
      const response = await oauthHandler.fetch(rpc("tools/list"));
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
        rpc("tools/list", {}, { authorization: `Bearer ${foreign}` }),
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
        await oauthHandler.fetch(rpc("tools/list"));
        await oauthHandler.fetch(
          rpc("tools/list", {}, { authorization: "Bearer nonsense" }),
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
      // No handshake: every 2026-07-28 request stands alone.
      return oauthHandler.fetch(
        rpc("tools/call", { arguments: {}, name }, bearer(scope)),
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

      await oauthHandler.fetch(rpc("tools/list"));
      await oauthHandler.fetch(
        rpc("tools/list", {}, { authorization: "Bearer nonsense" }),
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

      const response = await oauthHandler.fetch(
        rpc(
          "tools/call",
          { arguments: { profile_id: "zer0" }, name: "select_profile" },
          bearer("espresso:read espresso:write"),
        ),
      );

      expect(response.status).toBe(200);
      // The body has to be read before the side effect is asserted: the
      // response may be a stream, so the handler has not necessarily run to
      // completion until it is drained.
      const result = await readResult(response);
      expect(result.isError).toBeFalsy();
      expect(selected).toEqual(["15"]);
    });
  });
});
