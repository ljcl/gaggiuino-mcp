import { type Tool } from "@modelcontextprotocol/server";
import { createFetchHandler, type FetchHandler } from "./http";
import { type SecurityConfig } from "./mcpAuth";

/**
 * The MCP client for the tests that assert what a host actually receives.
 *
 * Several suites need the same thing: a real exchange through
 * `createFetchHandler`, driven over the transport rather than against the
 * in-memory server object. That distinction is the whole point — an
 * annotation, capability, or schema that does not serialize cannot influence
 * a host, and a table in memory proves nothing about the wire.
 *
 * The endpoint serves only the 2026-07-28 revision: no handshake at all;
 * every request carries the `io.modelcontextprotocol/*` envelope keys in
 * `params._meta` plus the `Mcp-Method` (and, where the body names one,
 * `Mcp-Name`) header, and capabilities come from `server/discover`.
 *
 * The convenience methods mirror a standard SDK client surface, including
 * throwing on a JSON-RPC error response.
 */

/** The 2026-07-28 revision every request names in its envelope. */
export const PROTOCOL_VERSION = "2026-07-28";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** A JSON-RPC response as it came off the wire. */
export interface JsonRpcResponse {
  error?: { code: number; data?: unknown; message: string };
  id?: number | string;
  jsonrpc?: string;
  result?: Record<string, unknown>;
}

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

/**
 * Every JSON payload in a response body. An exchange answers with a bare JSON
 * document unless the handler emitted notifications first (progress upgrades
 * it to SSE), so the parser accepts both shapes and returns each `data:` line
 * (or the one document) in order.
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
  /**
   * The `server/discover` result (`capabilities`, `supportedVersions`, and
   * `serverInfo` in `_meta`), fetched once on connect.
   */
  discover: Record<string, unknown>;
  /** Capabilities from `server/discover`. */
  getServerCapabilities(): Record<string, unknown> | undefined;
  /** `serverInfo` from `server/discover`'s `_meta`. */
  getServerVersion(): Record<string, unknown> | undefined;
  getPrompt(params: {
    arguments?: Record<string, string>;
    name: string;
  }): Promise<{
    messages: Array<{ content: { text: string; type: string }; role: string }>;
  }>;
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
function envelope(clientName: string): Record<string, unknown> {
  return {
    [META_CLIENT_CAPABILITIES]: {},
    [META_CLIENT_INFO]: { name: clientName, version: "1.0" },
    [META_VERSION]: PROTOCOL_VERSION,
  };
}

/** Connect a client bound to the handler and run `server/discover`. */
export async function connectTestClient(
  clientName = "test-client",
  handler: FetchHandler = createFetchHandler({ security: OPEN }),
): Promise<McpTestClient> {
  let nextId = 1;

  const sendRaw = async (method: string, params: unknown = {}) => {
    const merged = params as Record<string, unknown>;
    const body = {
      id: nextId++,
      jsonrpc: "2.0",
      method,
      params: {
        ...merged,
        // Caller-supplied keys win, so a test can override an envelope claim
        // (e.g. name an unsupported revision on purpose).
        _meta: {
          ...envelope(clientName),
          ...(merged._meta as Record<string, unknown> | undefined),
        },
      },
    };
    const headers: Record<string, string> = {
      "mcp-method": method,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    // SEP-2243: when the body names a tool, prompt, or resource uri, the
    // Mcp-Name header must carry the same value — the endpoint rejects a
    // mismatch or an absence with -32020.
    const name = merged.name ?? merged.uri;
    if (typeof name === "string") headers["mcp-name"] = name;
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

  // No handshake in this revision; `server/discover` is the optional probe
  // that replaced initialize's advertisement.
  const discover = (await send("server/discover")).result ?? {};

  // The `result` helper returns the untyped wire object; each sugar method
  // narrows it to the slice its suites assert on. The casts are the seam
  // between "whatever came off the wire" and "what a test may poke".
  return {
    callTool: ({ name, arguments: args }) =>
      result("tools/call", { arguments: args, name }),
    close: () => handler.shutdown(),
    discover,
    getPrompt: ({ name, arguments: args }) =>
      result("prompts/get", { arguments: args, name }) as Promise<{
        messages: Array<{
          content: { text: string; type: string };
          role: string;
        }>;
      }>,
    getServerCapabilities: () =>
      discover.capabilities as Record<string, unknown> | undefined,
    getServerVersion: () =>
      (discover._meta as Record<string, unknown> | undefined)?.[
        META_SERVER_INFO
      ] as Record<string, unknown> | undefined,
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
