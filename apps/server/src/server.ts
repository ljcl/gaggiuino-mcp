import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MACHINE_URL } from "./client";
import { describeUpstreamError } from "./errors";
import { loadPrompts } from "./loader";
import { logger } from "./logging";
import { getAllProfilesText, getProfile } from "./profiles";
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
  const fields = error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return `  - ${path || "(arguments)"}: ${issue.message}`;
    })
    .join("\n");
  return `Invalid arguments for ${toolName}:\n${fields}\nCheck the tool's input schema and call it again with corrected arguments.`;
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

export function createServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Expected failures come back as `isError` results, which is right for the
    // model but left the operator blind: a tool could fail every call and
    // nothing reached the logs. Every call is now one record, whatever the
    // outcome.
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
      const outcome = await handleToolCall(name, args ?? {});
      const result: {
        content: Array<{ text: string; type: "text" }>;
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      } = { content: [{ text: outcome.text, type: "text" }] };
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
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "espresso_shot_analyst",
        description: "System prompt for AI-assisted espresso dial-in",
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === "espresso_shot_analyst") {
      const prompts = loadPrompts();
      const prompt = prompts.espresso_shot_analyst;
      if (!prompt) {
        throw new Error("Missing prompt: espresso_shot_analyst");
      }
      const userContext = prompt.userContext ?? "";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: prompt.template
                .replace("{user_context}", userContext)
                .replace("{profiles_text}", getAllProfilesText()),
            },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "gaggiuino://profiles",
        name: "Available Brew Profiles",
        mimeType: "text/plain",
      },
      {
        uri: "ui://shot-graph/app.html",
        name: "Shot Graph",
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "gaggiuino://profiles") {
      return {
        contents: [{ uri, mimeType: "text/plain", text: getAllProfilesText() }],
      };
    }
    const profileMatch = uri.match(/^gaggiuino:\/\/profiles\/(.+)$/);
    const profileId = profileMatch?.[1];
    if (profileId) {
      const profile = getProfile(profileId);
      if (!profile) throw new Error(`Profile not found: ${profileId}`);
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
    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}
