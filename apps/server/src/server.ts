import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MACHINE_URL } from "./client";
import { describeUpstreamError, formatFieldIssues } from "./errors";
import { logger } from "./logging";
import { getAllProfilesText, getProfile } from "./profiles";
import { advertisedPrompts, renderPrompt } from "./prompts";
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
 * This is the layer both eras dispatch through — the legacy SDK handler and the
 * modern stateless dispatcher — so the logging contract ("every call is one
 * record") holds without either era knowing about the other. Expected failures
 * come back as `isError` results, which is right for the model but would leave
 * the operator blind if nothing reached the logs.
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

/** The advertised resource list, shared by both eras' `resources/list`. */
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
 * The advertised resource templates, shared by both eras.
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
 * Read one resource by URI, shared by both eras' `resources/read`.
 *
 * A URI this server does not hold comes back as `{ missing }` — text written
 * for the caller — rather than a throw, so each era answers in its own
 * vocabulary without reading a caught exception into a response body: the
 * modern dispatcher maps it to `-32602` (the 2026-07-28 revision retired the
 * old `-32002` resource-not-found code in favour of Invalid Params), and the
 * legacy handler converts it to the thrown error the SDK path always
 * produced.
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

export function createServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: SERVER_CAPABILITIES },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: advertisedPrompts(),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: renderPrompt(request.params.name, request.params.arguments),
        },
      },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const outcome = await readResource(request.params.uri);
    // The throw the SDK path has always answered with; the missing text is a
    // value so the modern era never has to read it off a caught exception.
    if ("missing" in outcome) throw new Error(outcome.missing);
    return outcome;
  });

  return server;
}
