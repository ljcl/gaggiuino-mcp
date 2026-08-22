import { type Tool } from "@modelcontextprotocol/server";
import { createFetchHandler, type FetchHandler } from "./http";
import { type SecurityConfig } from "./mcpAuth";

/**
 * One MCP client per protocol era for the tests that assert what a host
 * actually receives.
 *
 * Several suites need the same thing: a real exchange through
 * `createFetchHandler`, driven over the transport rather than against the
 * in-memory server object. That distinction is the whole point — an
 * annotation, capability, or schema that does not serialize cannot influence
 * a host, and a table in memory proves nothing about the wire.
 *
 * The endpoint serves two eras (dual era until clients finish migrating), so
 * the client speaks both:
 *
 * - `"legacy"` (the 2025 family): the `initialize` handshake, then plain
 *   JSON-RPC POSTs. The endpoint serves this era statelessly, so there is no
 *   `Mcp-Session-Id` — each request stands alone, which the 2025 spec always
 *   allowed.
 * - `"modern"` (2026-07-28): no handshake at all; every request carries the
 *   `io.modelcontextprotocol/*` envelope keys in `params._meta` plus the
 *   `Mcp-Method`/`Mcp-Name` headers, and capabilities come from
 *   `server/discover`.
 *
 * The convenience methods mirror a standard SDK client surface, including
 * throwing on a JSON-RPC error response.
 */

export type ProtocolEra = "legacy" | "modern";

/** The 2026-07-28 revision every modern-era request names in its envelope. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** The 2025-era revision the legacy handshake negotiates. */
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** A JSON-RPC response as it came off the wire. */
export interface JsonRpcResponse {
  error?: { code: number; data?: unknown; message: string };
  id?: number | string;
  jsonrpc?: string;
  result?: Record<string, unknown>;
}

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

/**
 * Every JSON payload in a response body. A modern exchange answers with a
 * bare JSON document unless the handler emitted notifications first; a legacy
 * exchange may answer on an SSE stream. So the parser accepts both shapes and
 * returns each `data:` line (or the one document) in order.
 */
export function parseBodyPayloads(raw: string): JsonRpcResponse[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return [JSON.parse(trimmed) as JsonRpcResponse];
  }
  return trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as JsonRpcResponse);
}

/**
 * The JSON-RPC *response* in a body that may also carry notifications — a
 * progress line arriving before the result must not be mistaken for it.
 */
export function parseResponse(raw: string): JsonRpcResponse | null {
  return (
    parseBodyPayloads(raw).find(
      (payload) =>
        payload.id !== undefined &&
        (payload.result !== undefined || payload.error !== undefined),
    ) ?? null
  );
}

/** The slices of each wire result the suites poke at. */
export interface PromptEntry {
  arguments?: Array<{ description?: string; name: string; required?: boolean }>;
  description?: string;
  name: string;
  title?: string;
}

export interface ResourceContentEntry {
  _meta?: Record<string, unknown>;
  mimeType?: string;
  text?: string;
  uri?: string;
}

export interface McpTestClient {
  /** Throws when the response is a JSON-RPC error. */
  callTool(params: {
    arguments?: Record<string, unknown>;
    name: string;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  era: ProtocolEra;
  /** Capabilities from the era's handshake (`initialize` / `server/discover`). */
  getServerCapabilities(): Record<string, unknown> | undefined;
  /** `serverInfo` from the era's handshake. */
  getServerVersion(): Record<string, unknown> | undefined;
  getPrompt(params: {
    arguments?: Record<string, string>;
    name: string;
  }): Promise<{
    messages: Array<{ content: { text: string; type: string }; role: string }>;
  }>;
  /**
   * The era's handshake result: the `initialize` result on legacy (with
   * `capabilities`, `serverInfo`, `protocolVersion`), the `server/discover`
   * result on modern (with `capabilities`, `supportedVersions`).
   */
  handshake: Record<string, unknown>;
  listPrompts(): Promise<{ prompts: PromptEntry[] }>;
  listResources(): Promise<{
    resources: Array<{ description?: string; uri: string }>;
  }>;
  listResourceTemplates(): Promise<{
    resourceTemplates: Array<{ uriTemplate: string }>;
  }>;
  listTools(): Promise<{ tools: Tool[] }>;
  readResource(params: {
    uri: string;
  }): Promise<{ contents: ResourceContentEntry[] }>;
  /** Send a request and return the parsed JSON-RPC response. */
  send(method: string, params?: unknown): Promise<JsonRpcResponse>;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8000/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

/** The reserved envelope keys a 2026-07-28 request carries in `params._meta`. */
function modernEnvelope(clientName: string): Record<string, unknown> {
  return {
    [META_CLIENT_CAPABILITIES]: {},
    [META_CLIENT_INFO]: { name: clientName, version: "1.0" },
    [META_VERSION]: MODERN_PROTOCOL_VERSION,
  };
}

/** Complete the era's bootstrap and return a client bound to the handler. */
export async function connectTestClient(
  clientName = "test-client",
  era: ProtocolEra = "legacy",
  handler: FetchHandler = createFetchHandler({ security: OPEN }),
): Promise<McpTestClient> {
  let nextId = 2;

  const sendRaw = async (method: string, params: unknown = {}) => {
    const id = nextId++;
    let body: Record<string, unknown>;
    let headers: Record<string, string> = {};
    if (era === "modern") {
      const merged = params as Record<string, unknown>;
      body = {
        id,
        jsonrpc: "2.0",
        method,
        params: {
          ...merged,
          // Caller-supplied keys win, so a test can override an envelope
          // claim (e.g. name an unsupported revision on purpose).
          _meta: {
            ...modernEnvelope(clientName),
            ...(merged._meta as Record<string, unknown> | undefined),
          },
        },
      };
      headers = {
        "mcp-method": method,
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      };
      // SEP-2243: when the body names a tool, prompt, or resource uri, the
      // Mcp-Name header must carry the same value — the modern path rejects
      // a mismatch or an absence with -32020.
      const name = merged.name ?? merged.uri;
      if (typeof name === "string") headers["mcp-name"] = name;
    } else {
      body = { id, jsonrpc: "2.0", method, params };
    }
    const response = await handler.fetch(post(body, headers));
    return await response.text();
  };

  const send = async (method: string, params: unknown = {}) => {
    const raw = await sendRaw(method, params);
    const parsed = parseResponse(raw);
    if (!parsed) throw new Error(`no JSON-RPC response in ${method}: ${raw}`);
    return parsed;
  };

  /** Contract: a JSON-RPC error response becomes a throw. */
  const result = async (method: string, params: unknown = {}) => {
    const parsed = await send(method, params);
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result ?? {};
  };

  let handshake: Record<string, unknown>;
  if (era === "modern") {
    // Modern needs no handshake; `server/discover` is the optional probe that
    // replaces initialize's advertisement.
    handshake = (await send("server/discover")).result ?? {};
  } else {
    const init = await handler.fetch(
      post({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: clientName, version: "1.0" },
          protocolVersion: LEGACY_PROTOCOL_VERSION,
        },
      }),
    );
    handshake = parseResponse(await init.text())?.result ?? {};
    await handler.fetch(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
  }

  // The `result` helper returns the untyped wire object; each sugar method
  // narrows it to the slice its suites assert on. The casts are the seam
  // between "whatever came off the wire" and "what a test may poke".
  return {
    callTool: ({ name, arguments: args }) =>
      result("tools/call", { arguments: args, name }),
    close: () => handler.shutdown(),
    era,
    getPrompt: ({ name, arguments: args }) =>
      result("prompts/get", { arguments: args, name }) as Promise<{
        messages: Array<{
          content: { text: string; type: string };
          role: string;
        }>;
      }>,
    getServerCapabilities: () =>
      handshake.capabilities as Record<string, unknown> | undefined,
    getServerVersion: () =>
      handshake.serverInfo as Record<string, unknown> | undefined,
    handshake,
    listPrompts: () =>
      result("prompts/list") as Promise<{ prompts: PromptEntry[] }>,
    listResources: () =>
      result("resources/list") as Promise<{
        resources: Array<{ description?: string; uri: string }>;
      }>,
    listResourceTemplates: () =>
      result("resources/templates/list") as Promise<{
        resourceTemplates: Array<{ uriTemplate: string }>;
      }>,
    listTools: () => result("tools/list") as Promise<{ tools: Tool[] }>,
    readResource: ({ uri }) =>
      result("resources/read", { uri }) as Promise<{
        contents: ResourceContentEntry[];
      }>,
    send,
  };
}
