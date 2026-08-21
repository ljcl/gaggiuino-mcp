import fs from "node:fs/promises";
import { createRequire } from "node:module";
import {
  type CallToolResult,
  INVALID_PARAMS,
  type ListResourcesResult,
  type ListToolsResult,
  ProtocolError,
  type ReadResourceResult,
  ResourceNotFoundError,
  Server,
  type Tool,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { MACHINE_URL } from "./client";
import { describeUpstreamError, formatFieldIssues } from "./errors";
import { logger } from "./logging";
import { getAllProfilesText, getProfile } from "./profiles";
import { advertisedPrompts, tryRenderPrompt } from "./prompts";
import { TOOL_DEFINITIONS, TOOLS_BY_NAME, type ToolDefinition } from "./tools";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * Resolved once at startup via the `@gaggiuino/shot-graph` package's `./app.html`
 * export. Works in dev (workspace symlink) and in the Docker runner (pruned
 * workspace tree with built dist/ copied in).
 */
const SHOT_GRAPH_HTML_PATH = createRequire(import.meta.url).resolve(
  "@gaggiuino/shot-graph/app.html",
);

/**
 * Turn a tool's zod schema into the JSON Schema advertised over the wire.
 *
 * Input schemas are generated in `io: "input"` mode and output schemas in
 * `io: "output"` mode, which is what each side actually describes: the input
 * schema documents what a caller may send (so a coercing id schema advertises
 * both accepted forms), the output schema documents what we return.
 */
function toJsonSchema(
  schema: z.ZodObject,
  io: "input" | "output",
): Tool["inputSchema"] {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io });
  return rest as Tool["inputSchema"];
}

function toMcpTool(tool: ToolDefinition): Tool {
  const mcpTool: Tool = {
    annotations: tool.annotations,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema, "input"),
    name: tool.name,
    title: tool.title,
  };
  if (tool.outputSchema) {
    mcpTool.outputSchema = toJsonSchema(tool.outputSchema, "output");
  }
  if (tool.meta) {
    mcpTool._meta = tool.meta;
  }
  return mcpTool;
}

/** The advertised tool list, derived from the same schemas the dispatcher enforces. */
export const TOOLS: Tool[] = TOOL_DEFINITIONS.map(toMcpTool);

export interface ToolOutcome {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  text: string;
}

function describeInvalidInput(toolName: string, error: z.ZodError): string {
  return `Invalid arguments for ${toolName}:\n${formatFieldIssues(error)}\nCheck the tool's input schema and call it again with corrected arguments.`;
}

/**
 * The one place a tool call is validated and run.
 *
 * Input is parsed against the tool's zod schema before the handler sees it, so
 * no handler casts or guesses. Expected failures — bad arguments, a shot that
 * does not exist, a machine that will not answer — come back as `isError`
 * outcomes the model can act on. Anything else is a bug and is allowed to
 * throw.
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return { isError: true, text: describeInvalidInput(name, parsed.error) };
  }

  let reply: Awaited<ReturnType<ToolDefinition["handler"]>>;
  try {
    reply = await tool.handler(parsed.data);
  } catch (error) {
    const actionable = describeUpstreamError(error, MACHINE_URL);
    if (actionable === null) throw error;
    return { isError: true, text: actionable };
  }

  if ("isError" in reply) {
    return { isError: true, text: reply.text };
  }

  if (!tool.outputSchema) {
    return { text: reply.text };
  }

  // Parsing on the way out keeps `structuredContent` and the advertised
  // `outputSchema` in lockstep: a handler that drifts from its schema fails
  // here rather than shipping a payload the host cannot validate.
  return {
    structuredContent: tool.outputSchema.parse(reply.structured) as Record<
      string,
      unknown
    >,
    text: reply.text,
  };
}

/**
 * The capabilities both eras advertise: the legacy `initialize` result and the
 * modern `server/discover` result read this one constant, so the two answers
 * cannot drift. Deliberately no `listChanged` (and no `resources.subscribe`):
 * every list this server serves is a module-level constant, and `listChanged`
 * is a promise to tell the host to re-fetch — a re-fetch being exactly what
 * re-keys the cached tools a permission grant is stored against.
 */
export const SERVER_CAPABILITIES = {
  prompts: {},
  resources: {},
  tools: {},
} as const;

/**
 * The one JSON-RPC shape a `tools/call` answer takes, whichever era asked.
 * A `type` rather than an `interface` because the SDK's handler signature
 * demands an implicit index signature, which only object type aliases carry.
 */
export type CallToolResultShape = {
  content: Array<{ text: string; type: "text" }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/**
 * Run one tool call and log it, whatever the outcome.
 *
 * The one dual-era dispatch layer, so the logging contract ("every call is
 * one record") holds whichever era asked. Expected failures come back as
 * `isError` results, which is right for the model but would leave the
 * operator blind if nothing reached the logs.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResultShape> {
  const startedAt = performance.now();
  const finish = (outcome: string, fields?: Record<string, unknown>) => {
    logger.info("tool.call", {
      durationMs: Math.round(performance.now() - startedAt),
      outcome,
      tool: name,
      ...fields,
    });
  };

  try {
    const outcome = await handleToolCall(name, args);
    const result: CallToolResultShape = {
      content: [{ text: outcome.text, type: "text" }],
    };
    if (outcome.isError) result.isError = true;
    if (outcome.structuredContent) {
      result.structuredContent = outcome.structuredContent;
    }
    // The text of an expected failure is written to be actionable, so it is
    // worth carrying into the log rather than a bare "error".
    finish(outcome.isError ? "error" : "ok", {
      ...(outcome.isError ? { reason: outcome.text } : {}),
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Reaching here means a bug rather than an upstream failure, so it logs
    // at error level with the stack the model result cannot carry.
    logger.error("tool.error", {
      durationMs: Math.round(performance.now() - startedAt),
      reason: message,
      stack: error instanceof Error ? error.stack : undefined,
      tool: name,
    });
    return {
      content: [{ text: `Tool error: ${message}`, type: "text" }],
      isError: true,
    };
  }
}

/** The advertised resource list. */
export const RESOURCES = [
  {
    uri: "gaggiuino://profiles",
    name: "Available Brew Profiles",
    description:
      "Documented brew profiles as a plain-text summary: type, suitable roast levels, target ratio, and target time for each. This is bundled documentation — call list_profiles for what is actually loaded on the machine.",
    mimeType: "text/plain",
  },
  {
    uri: "ui://shot-graph/app.html",
    name: "Shot Graph",
    description:
      "The interactive shot chart rendered by view_shot_graph. Hosts fetch this to display that tool's result; there is nothing here to read as text.",
    mimeType: "text/html;profile=mcp-app",
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
];

/**
 * The advertised resource templates.
 *
 * Declaring the `resources` capability commits the server to the whole
 * resource discovery flow, and `resources/templates/list` is part of it — the
 * spec's own message flow puts it immediately after `resources/list`. Without
 * a handler the request fell through to the SDK's default and came back
 * `-32601 Method not found`, so a host enumerating the server mid-refresh saw
 * a hard JSON-RPC error and abandoned the whole discovery pass, tools
 * included. Answering it also makes the `gaggiuino://profiles/{id}` branch of
 * `readResource` reachable, which was previously advertised nowhere.
 */
export const RESOURCE_TEMPLATES = [
  {
    description:
      "Documentation for a single brew profile. Ids come from list_profiles or the gaggiuino://profiles resource.",
    mimeType: "text/plain",
    name: "Brew Profile",
    uriTemplate: "gaggiuino://profiles/{id}",
  },
];

/** A `type` for the same implicit-index-signature reason as {@link CallToolResultShape}. */
export type ResourceContents = {
  contents: Array<{
    _meta?: Record<string, unknown>;
    mimeType: string;
    text: string;
    uri: string;
  }>;
};

/**
 * Read one resource by URI, for the one dual-era `resources/read` handler.
 *
 * A URI this server does not hold comes back as `{ missing }` — text written
 * for the caller — rather than a throw, so the handler stays the only place an
 * expected failure becomes an exception, and the exception it throws is the
 * SDK's typed `ResourceNotFoundError`: the SDK serialises it per era
 * (`-32602` on 2026-07-28, which retired the old `-32002` code in favour of
 * Invalid Params) without this module ever reading text off a caught
 * exception into a response body.
 */
export async function readResource(
  uri: string,
): Promise<ResourceContents | { missing: string }> {
  if (uri === "gaggiuino://profiles") {
    return {
      contents: [{ uri, mimeType: "text/plain", text: getAllProfilesText() }],
    };
  }
  const profileMatch = uri.match(/^gaggiuino:\/\/profiles\/(.+)$/);
  const profileId = profileMatch?.[1];
  if (profileId) {
    const profile = getProfile(profileId);
    if (!profile) return { missing: `Profile not found: ${profileId}` };
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `# ${profile.name}\n\n${profile.description}`,
        },
      ],
    };
  }
  if (uri === "ui://shot-graph/app.html") {
    const html = await fs.readFile(SHOT_GRAPH_HTML_PATH, "utf-8");
    return {
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    };
  }
  return { missing: `Unknown resource: ${uri}` };
}

/**
 * How long a client may cache the static surface (`server/discover` and the
 * four list/read methods, the 2026-07-28 revision's closed cacheable set).
 *
 * An hour, because everything under it is a module-level constant that changes
 * only on redeploy — the same fact behind the missing `listChanged` claims.
 * `cacheScope` stays on the SDK's `private` default although nothing served is
 * user-specific: the documented deployment gates `/mcp` behind OAuth, and a
 * scope that forbids shared intermediaries caching across authorization
 * contexts can never serve a gated answer to a caller the gate would refuse;
 * `public` would only buy shared-gateway caching, worth nothing on a
 * single-user server.
 */
const STATIC_SURFACE_TTL_MS = 3_600_000;

/**
 * One server factory backs both eras: `createMcpHandler` in `http.ts` serves
 * a fresh instance per request, and the v2 SDK's wire codec does the
 * era-shaping — `resultType`, the `ttlMs`/`cacheScope` stamps from
 * `cacheHints`, per-result `serverInfo`, and `server/discover` itself — so
 * these handlers describe the surface once and never branch on the protocol
 * version.
 */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      cacheHints: {
        "prompts/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "resources/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "resources/read": { ttlMs: STATIC_SURFACE_TTL_MS },
        "resources/templates/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "server/discover": { ttlMs: STATIC_SURFACE_TTL_MS },
        "tools/list": { ttlMs: STATIC_SURFACE_TTL_MS },
      },
      capabilities: SERVER_CAPABILITIES,
    },
  );

  // The SDK's result types spell out every reserved `_meta` envelope key,
  // which the generated JSON-schema tables here cannot satisfy structurally;
  // the wire shape these serialize to is what the tests assert, so the casts
  // are confined to this seam.
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS as unknown as ListToolsResult["tools"],
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    const result = await callTool(
      name,
      (args as Record<string, unknown>) ?? {},
    );
    // The era-aware projection lives in the SDK codec; low-level tools/call
    // handlers route through it themselves. Identity for this server's
    // always-text, object-structured results.
    return server.projectCallToolResult(
      result as CallToolResult,
      TOOLS.find((tool) => tool.name === name)?.outputSchema,
    );
  });

  server.setRequestHandler("prompts/list", async () => ({
    prompts: advertisedPrompts(),
  }));
  server.setRequestHandler("prompts/get", async (request) => {
    // A prompt has no `isError` channel: a bad request is a JSON-RPC error,
    // which is what a host needs to put the missing field back in front of
    // the user. The refusal arrives as a value and becomes the SDK's typed
    // Invalid Params error — nothing here reads text off a caught exception,
    // so a genuine bug propagates instead of leaking its internals.
    const outcome = tryRenderPrompt(
      request.params.name,
      request.params.arguments,
    );
    if ("invalid" in outcome) {
      throw new ProtocolError(INVALID_PARAMS, outcome.invalid);
    }
    return {
      messages: [
        { content: { text: outcome.text, type: "text" }, role: "user" },
      ],
    };
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: RESOURCES as unknown as ListResourcesResult["resources"],
  }));
  server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));
  server.setRequestHandler("resources/read", async (request) => {
    const outcome = await readResource(request.params.uri);
    if ("missing" in outcome) {
      throw new ResourceNotFoundError(request.params.uri, outcome.missing);
    }
    return outcome as unknown as ReadResourceResult;
  });

  return server;
}
