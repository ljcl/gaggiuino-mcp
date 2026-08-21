import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler, type FetchHandler } from "./http";
import { setLogLevel } from "./logging";
import { type SecurityConfig } from "./mcpAuth";
import { MODERN_PROTOCOL_VERSIONS } from "./modern";
import { TEST_OAUTH_CONFIG } from "./oauth/__fixtures__";
import { signToken } from "./oauth/tokens";
import { advertisedPrompts } from "./prompts";
import * as serverModule from "./server";
import { SERVER_CAPABILITIES, TOOLS } from "./server";
import { SERVER_NAME, SERVER_VERSION } from "./version";

// Spies with the real implementations kept, so one test can make
// `readResource` fail like a genuine bug without hand-writing a mock of the
// module every other test depends on.
vi.mock("./server", { spy: true });

/**
 * The modern (2026-07-28) half of the dual-era server, driven through the real
 * fetch handler like `http.test.ts` drives the legacy half — the routing, the
 * security gate, and the era split are all in the loop.
 *
 * The one fact this file exists to hold: **the two eras advertise one
 * surface**. A host migrating eras must see byte-identical tools, or the
 * permission grants it stored against the legacy list silently drop.
 */

const MODERN_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

let handler: FetchHandler;

interface BodyOverrides {
  /** Replace the whole `_meta`; `null` omits it. */
  meta?: Record<string, unknown> | null;
  version?: string;
}

function modernBody(
  method: string,
  params: Record<string, unknown> = {},
  overrides: BodyOverrides = {},
): Record<string, unknown> {
  const meta =
    overrides.meta === null
      ? undefined
      : (overrides.meta ?? {
          [META_CAPABILITIES]: {},
          [META_VERSION]: overrides.version ?? MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "modern-test",
            version: "1.0",
          },
        });
  return {
    id: 1,
    jsonrpc: "2.0",
    method,
    params: { ...params, ...(meta ? { _meta: meta } : {}) },
  };
}

interface HeaderOverrides {
  method?: string | null;
  name?: string | null;
  version?: string | null;
}

function modernHeaders(
  method: string,
  overrides: HeaderOverrides = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const version =
    overrides.version === null ? null : (overrides.version ?? MODERN_VERSION);
  if (version !== null) headers["mcp-protocol-version"] = version;
  const methodHeader =
    overrides.method === null ? null : (overrides.method ?? method);
  if (methodHeader !== null) headers["mcp-method"] = methodHeader;
  if (overrides.name != null) headers["mcp-name"] = overrides.name;
  return headers;
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler.fetch(
    new Request("http://localhost:8000/mcp", {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    }),
  );
}

/** POST one well-formed modern request. */
function call(
  method: string,
  params: Record<string, unknown> = {},
  headers: HeaderOverrides = {},
): Promise<Response> {
  return post(modernBody(method, params), modernHeaders(method, headers));
}

interface RpcError {
  code: number;
  data?: { requested?: string; supported?: string[] };
  message: string;
}

async function readError(response: Response): Promise<RpcError> {
  const body = (await response.json()) as { error: RpcError };
  return body.error;
}

async function readResult(
  response: Response,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as { result: Record<string, unknown> };
  return body.result;
}

beforeEach(() => {
  handler = createFetchHandler({ security: OPEN });
});

afterEach(async () => {
  await handler.shutdown();
});

describe("era detection", () => {
  it("serves a modern request statelessly: no initialize, no session", async () => {
    const result = await readResult(await call("tools/list"));
    expect(Array.isArray(result.tools)).toBe(true);
    // Nothing session-shaped leaks into the modern era: no id is minted and
    // no transport is held for a request that carries its own context.
    expect(handler.sessions.size).toBe(0);
  });

  it("ignores a stale Mcp-Session-Id on a modern request", async () => {
    // The modern transport says to ignore session headers, not to 404 on
    // them. Routed to the legacy path this would answer "session not found"
    // and tell a stateless client to re-handshake — a loop with no exit.
    const response = await post(modernBody("tools/list"), {
      ...modernHeaders("tools/list"),
      "mcp-session-id": "left-over-from-the-legacy-era",
    });
    expect(response.status).toBe(200);
  });

  it("still serves the legacy era alongside", async () => {
    // Dual-era means concurrently on the same endpoint: a legacy handshake
    // works before and after modern traffic, sessions and all.
    await readResult(await call("server/discover"));
    const init = await post({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0" },
        protocolVersion: "2025-06-18",
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect(handler.sessions.size).toBe(1);
  });

  it("routes a modern header with a legacy-shaped body to the modern error", async () => {
    // A half-migrated client gets the modern HeaderMismatch it can act on,
    // not the legacy path's "no valid session ID" — which would read as a
    // legacy server and cancel the client's fall-forward.
    const response = await post(
      { id: 1, jsonrpc: "2.0", method: "tools/list" },
      modernHeaders("tools/list"),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32020);
  });

  it("routes a bare server/discover to a modern error, not the legacy 400", async () => {
    // server/discover is the era probe. A non-modern error body is precisely
    // what tells a dual-era client to fall back to initialize — wrong, here.
    const response = await post({
      id: 1,
      jsonrpc: "2.0",
      method: "server/discover",
    });
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32020);
  });

  it("leaves JSON-RPC batches to the legacy era", async () => {
    // The modern body is a single request; batches belong to the era that
    // allowed them. This one names no session, so the legacy path refuses it
    // with its own error — the point is only that the modern path did not
    // claim it.
    const response = await post(
      [modernBody("tools/list")],
      modernHeaders("tools/list"),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32000);
  });
});

describe("request validation", () => {
  it("rejects a missing MCP-Protocol-Version header", async () => {
    const response = await post(
      modernBody("tools/list"),
      modernHeaders("tools/list", { version: null }),
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32020);
    expect(error.message).toContain("MCP-Protocol-Version");
  });

  it("rejects a header that disagrees with the body version", async () => {
    const response = await post(
      modernBody("tools/list", {}, { version: "2026-07-28" }),
      modernHeaders("tools/list", { version: "2099-01-01" }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32020);
  });

  it("rejects an unsupported version with the list to retry from", async () => {
    // -32022 is the fall-forward signal: the client picks from `supported`
    // and re-sends. Legacy versions are deliberately absent from that list —
    // they cannot be served with per-request metadata, so advertising them
    // here would invite a retry that cannot work.
    const response = await post(
      modernBody("tools/list", {}, { version: "2025-11-25" }),
      modernHeaders("tools/list", { version: "2025-11-25" }),
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32022);
    expect(error.data).toEqual({
      requested: "2025-11-25",
      supported: [...MODERN_PROTOCOL_VERSIONS],
    });
  });

  it("rejects a missing Mcp-Method header", async () => {
    const response = await post(
      modernBody("tools/list"),
      modernHeaders("tools/list", { method: null }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).message).toContain("Mcp-Method");
  });

  it("rejects an Mcp-Method header that disagrees with the body", async () => {
    const response = await post(
      modernBody("tools/list"),
      modernHeaders("tools/list", { method: "tools/call" }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).message).toContain("tools/call");
  });

  it("requires Mcp-Name on tools/call", async () => {
    const response = await call("tools/call", {
      arguments: {},
      name: "get_dial_in_guidance",
    });
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32020);
    expect(error.message).toContain("Mcp-Name");
  });

  it("rejects an Mcp-Name that disagrees with the body", async () => {
    const response = await call(
      "tools/call",
      { arguments: {}, name: "get_dial_in_guidance" },
      { name: "get_status" },
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32020);
  });

  it("rejects an Mcp-Name whose body value is missing entirely", async () => {
    const response = await call(
      "tools/call",
      { arguments: {} },
      { name: "get_status" },
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32020);
    expect(error.message).toContain("(absent)");
  });

  it("round-trips a string request id", async () => {
    const response = await post(
      { ...modernBody("tools/list"), id: "req-7" },
      modernHeaders("tools/list"),
    );
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe("req-7");
  });

  it("decodes the Base64 sentinel before comparing Mcp-Name", async () => {
    // Names outside the header-safe set ride as `=?base64?...?=`; servers
    // MUST decode before comparing, or every such call would 400.
    const encoded = `=?base64?${Buffer.from("get_dial_in_guidance", "utf8").toString("base64")}?=`;
    const response = await call(
      "tools/call",
      { arguments: {}, name: "get_dial_in_guidance" },
      { name: encoded },
    );
    const result = await readResult(response);
    expect(result.isError).toBeUndefined();
  });

  it("rejects a request missing clientCapabilities", async () => {
    const response = await post(
      modernBody(
        "tools/list",
        {},
        { meta: { [META_VERSION]: MODERN_VERSION } },
      ),
      modernHeaders("tools/list"),
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32602);
    expect(error.message).toContain(META_CAPABILITIES);
  });

  it("answers an unknown method with 404 and -32601", async () => {
    // The pair is the point: the 404 is for intermediaries, the -32601 body
    // is what tells a client this is a modern server missing the method —
    // not a legacy HTTP+SSE server missing the endpoint.
    const response = await call("logging/setLevel", { level: "debug" });
    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe(-32601);
  });

  it("answers the removed initialize-era methods the same way", async () => {
    const response = await call("ping");
    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe(-32601);
  });

  it("accepts a notification with 202 and no body", async () => {
    const body = modernBody("notifications/whatever");
    delete body.id;
    const response = await post(body, modernHeaders("notifications/whatever"));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects a null id", async () => {
    // Unlike base JSON-RPC, MCP bans null ids outright.
    const response = await post(
      { ...modernBody("tools/list"), id: null },
      modernHeaders("tools/list"),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32600);
  });

  it("rejects a body with no method", async () => {
    const response = await post(
      {
        id: 1,
        jsonrpc: "2.0",
        params: { _meta: { [META_VERSION]: MODERN_VERSION } },
      },
      modernHeaders("tools/list"),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32600);
  });
});

describe("server/discover", () => {
  it("advertises versions, capabilities and identity in one cacheable result", async () => {
    const result = await readResult(await call("server/discover"));
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual([...MODERN_PROTOCOL_VERSIONS]);
    // The same constant the legacy initialize result reads, so the two
    // eras' answers cannot drift.
    expect(result.capabilities).toEqual(SERVER_CAPABILITIES);
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe("private");
    expect((result._meta as Record<string, unknown>)[META_SERVER_INFO]).toEqual(
      { name: SERVER_NAME, version: SERVER_VERSION },
    );
  });
});

describe("the advertised surface", () => {
  it("serves the exact tool list the legacy era serves", async () => {
    // The grant-parity assertion this file exists for: `TOOLS` is what the
    // legacy handler returns, so deep equality here means a host migrating
    // eras re-keys nothing.
    const result = await readResult(await call("tools/list"));
    expect(result.tools).toEqual(TOOLS);
    expect(result.resultType).toBe("complete");
  });

  it("carries annotations and _meta across this wire path too", async () => {
    // `http.test.ts` proves the legacy transport does not drop them; this
    // path serialises independently, so it is asserted independently.
    const result = await readResult(await call("tools/list"));
    const tools = result.tools as Tool[];
    const remove = tools.find((tool) => tool.name === "delete_profile");
    expect(remove?.annotations?.destructiveHint).toBe(true);
    const removeMeta = (remove?._meta ?? {}) as Record<string, unknown>;
    expect(removeMeta["anthropic/requiresUserInteraction"]).toBe(true);
    const write = tools.find((tool) => tool.name === "select_profile");
    expect(write?.annotations?.readOnlyHint).toBe(false);
  });

  it("serves the same prompt list as the legacy era", async () => {
    const result = await readResult(await call("prompts/list"));
    expect(result.prompts).toEqual(advertisedPrompts());
  });

  it("marks every list and read result cacheable", async () => {
    // The 2026-07-28 CacheableResult contract: ttlMs and cacheScope are
    // required on exactly these five methods.
    const cacheable = [
      call("server/discover"),
      call("tools/list"),
      call("prompts/list"),
      call("resources/list"),
      call("resources/templates/list"),
    ];
    for (const pending of cacheable) {
      const result = await readResult(await pending);
      expect(result.ttlMs).toBeGreaterThan(0);
      expect(result.cacheScope).toBe("private");
    }
  });

  it("lists both resources and the profile template", async () => {
    const listed = await readResult(await call("resources/list"));
    const resources = listed.resources as Array<{ uri: string }>;
    expect(resources.map((resource) => resource.uri)).toEqual([
      "gaggiuino://profiles",
      "ui://shot-graph/app.html",
    ]);

    const templates = await readResult(await call("resources/templates/list"));
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "gaggiuino://profiles/{id}" }),
    ]);
  });
});

describe("tools/call", () => {
  it("runs a tool and stamps the modern result fields", async () => {
    const response = await call(
      "tools/call",
      { arguments: {}, name: "get_dial_in_guidance" },
      { name: "get_dial_in_guidance" },
    );
    const result = await readResult(response);
    expect(result.resultType).toBe("complete");
    const content = result.content as Array<{ text: string; type: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text.length).toBeGreaterThan(100);
    expect((result._meta as Record<string, unknown>)[META_SERVER_INFO]).toEqual(
      { name: SERVER_NAME, version: SERVER_VERSION },
    );
  });

  it("returns an unknown tool as an isError result, not a JSON-RPC error", async () => {
    // Expected failures are results the model can read — the same contract
    // as the legacy era, running through the same `callTool`.
    const response = await call(
      "tools/call",
      { arguments: {}, name: "no_such_tool" },
      { name: "no_such_tool" },
    );
    const result = await readResult(response);
    expect(result.isError).toBe(true);
  });
});

describe("prompts/get", () => {
  it("renders a prompt", async () => {
    const response = await call(
      "prompts/get",
      { arguments: { taste: "sour and thin" }, name: "diagnose_last_shot" },
      { name: "diagnose_last_shot" },
    );
    const result = await readResult(response);
    const messages = result.messages as Array<{
      content: { text: string };
      role: string;
    }>;
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content.text).toContain("sour and thin");
  });

  it("answers a missing required argument with -32602", async () => {
    // A prompt has no isError channel; the JSON-RPC error is what a host
    // needs to put the field back in front of the user.
    const response = await call(
      "prompts/get",
      { arguments: {}, name: "diagnose_last_shot" },
      { name: "diagnose_last_shot" },
    );
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("taste");
  });

  it("answers an unknown prompt with -32602", async () => {
    const response = await call(
      "prompts/get",
      { name: "no_such_prompt" },
      { name: "no_such_prompt" },
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32602);
  });
});

describe("resources/read", () => {
  it("reads the profiles document", async () => {
    const response = await call(
      "resources/read",
      { uri: "gaggiuino://profiles" },
      { name: "gaggiuino://profiles" },
    );
    const result = await readResult(response);
    const contents = result.contents as Array<{ text: string; uri: string }>;
    expect(contents[0]?.uri).toBe("gaggiuino://profiles");
    expect(contents[0]?.text.length).toBeGreaterThan(0);
    expect(result.ttlMs).toBeGreaterThan(0);
  });

  it("reads one documented profile through the template", async () => {
    const response = await call(
      "resources/read",
      { uri: "gaggiuino://profiles/londinium" },
      { name: "gaggiuino://profiles/londinium" },
    );
    const result = await readResult(response);
    const contents = result.contents as Array<{ text: string }>;
    expect(contents[0]?.text).toContain("#");
  });

  it("serves the MCP App bundle with its mime profile", async () => {
    const response = await call(
      "resources/read",
      { uri: "ui://shot-graph/app.html" },
      { name: "ui://shot-graph/app.html" },
    );
    const result = await readResult(response);
    const contents = result.contents as Array<{ mimeType: string }>;
    expect(contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("answers an unknown resource with -32602, not the retired -32002", async () => {
    // 2026-07-28 renumbered resource-not-found onto Invalid Params and
    // forbids emitting the old code.
    const response = await call(
      "resources/read",
      { uri: "gaggiuino://nope" },
      { name: "gaggiuino://nope" },
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32602);
  });

  it("answers a missing profile with -32602 as well", async () => {
    const response = await call(
      "resources/read",
      { uri: "gaggiuino://profiles/never-documented" },
      { name: "gaggiuino://profiles/never-documented" },
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32602);
  });

  it("lets a genuine read failure propagate as the bug it is", async () => {
    // Only ResourceNotFoundError maps to -32602; anything else is a bug and
    // must not be dressed up as an invalid-params answer the client would
    // retry with different params.
    vi.mocked(serverModule.readResource).mockRejectedValueOnce(
      new Error("bundle missing from disk"),
    );
    await expect(
      call(
        "resources/read",
        { uri: "gaggiuino://profiles" },
        { name: "gaggiuino://profiles" },
      ),
    ).rejects.toThrow("bundle missing from disk");
  });
});

describe("subscriptions/listen", () => {
  it("acknowledges an empty honoured set and closes gracefully", async () => {
    // Every list this server serves is a module-level constant — the same
    // fact behind the missing listChanged claims — so the honest stream is
    // the spec's own teardown: ack with nothing honoured, then the close
    // result. Holding the socket open would tell the client nothing more.
    const response = await call("subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = (await response.text())
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map(
        (chunk) =>
          JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>,
      );
    expect(events).toHaveLength(2);

    const ack = events[0] as {
      method: string;
      params: { _meta: Record<string, unknown>; notifications: object };
    };
    expect(ack.method).toBe("notifications/subscriptions/acknowledged");
    expect(ack.params.notifications).toEqual({});
    expect(ack.params._meta[META_SUBSCRIPTION_ID]).toBe(1);

    const closed = events[1] as {
      id: number;
      result: { _meta: Record<string, unknown>; resultType: string };
    };
    expect(closed.id).toBe(1);
    expect(closed.result.resultType).toBe("complete");
    expect(closed.result._meta[META_SUBSCRIPTION_ID]).toBe(1);
  });

  it("rejects a listen with no notification filter", async () => {
    const response = await call("subscriptions/listen");
    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(-32602);
  });
});

describe("the security gate, modern era", () => {
  const GATED: SecurityConfig = {
    allowedHosts: [],
    allowedOrigins: [],
    oauth: TEST_OAUTH_CONFIG,
  };

  function bearer(scope: string): Record<string, string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = signToken(
      {
        aud: `${TEST_OAUTH_CONFIG.publicOrigin}/mcp`,
        exp: issuedAt + 3600,
        iat: issuedAt,
        iss: TEST_OAUTH_CONFIG.issuer,
        jti: "id",
        scope,
        sub: "owner",
      },
      // The built-in branch of the discriminated union always carries it.
      (TEST_OAUTH_CONFIG as { secret: string }).secret,
      "access-token",
    );
    return { authorization: `Bearer ${token}` };
  }

  beforeEach(() => {
    handler = createFetchHandler({ security: GATED });
  });

  it("401s an unauthenticated modern request like any other", async () => {
    // Auth stays an HTTP status in every era; nothing about statelessness
    // moves the gate.
    const response = await call("tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("403s a modern write call on a read-only token before dispatch", async () => {
    // The scope gate runs on the parsed body ahead of the era split, so the
    // modern era inherited it rather than reimplementing it.
    const response = await post(
      modernBody("tools/call", {
        arguments: { confirm_name: "x", profile_id: "x" },
        name: "delete_profile",
      }),
      {
        ...modernHeaders("tools/call", { name: "delete_profile" }),
        ...bearer("espresso:read"),
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "insufficient_scope",
    );
  });

  it("serves a modern read on a read-only token", async () => {
    const response = await post(modernBody("tools/list"), {
      ...modernHeaders("tools/list"),
      ...bearer("espresso:read"),
    });
    expect(response.status).toBe(200);
  });
});

describe("rejection logging", () => {
  it("records every modern refusal with its code and status", async () => {
    // The same argument `security.rejected` makes: a silent 4xx leaves a
    // half-migrated client indistinguishable from an unreachable server.
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)) as Record<string, unknown>);
    });
    setLogLevel("warn");
    try {
      await call("nonexistent/method");
    } finally {
      spy.mockRestore();
      setLogLevel("silent");
    }
    expect(
      records.find((entry) => entry.event === "modern.rejected"),
    ).toMatchObject({ code: -32601, status: 404 });
  });
});

describe("CORS for modern browser clients", () => {
  it("allows the mirrored metadata headers through the preflight", async () => {
    // A browser client must be able to send Mcp-Method and Mcp-Name, or the
    // preflight fails a request the origin allowlist was meant to permit.
    handler = createFetchHandler({
      security: { allowedHosts: [], allowedOrigins: ["https://claude.ai"] },
    });
    const response = await handler.fetch(
      new Request("http://localhost:8000/mcp", {
        headers: {
          "access-control-request-headers": "mcp-method, mcp-name",
          "access-control-request-method": "POST",
          origin: "https://claude.ai",
        },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(204);
    const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed).toContain("mcp-method");
    expect(allowed).toContain("mcp-name");
  });
});
