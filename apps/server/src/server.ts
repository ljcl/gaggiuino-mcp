import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  formatShotSummary,
  generateShotSummary,
  normalizeValue,
  SCALE_BY_10,
} from "./analysis";
import { createClient } from "./client";
import { loadPrompts } from "./loader";
import { getAllProfilesText, getProfile, listProfileNames } from "./profiles";

const GAGGIUINO_URL = process.env.GAGGIUINO_URL ?? "http://gaggiuino.local";

let _client: ReturnType<typeof createClient> | null = null;
function getClient() {
  if (!_client) {
    _client = createClient({ baseUrl: GAGGIUINO_URL });
  }
  return _client;
}

export function resetClient() {
  _client = null;
}

const TOOLS = [
  {
    name: "get_status",
    description: "Get the current status of the Gaggiuino espresso machine.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_latest_shot_id",
    description: "Get the ID of the most recent espresso shot.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_shot_data",
    description: "Get a structured summary of a specific espresso shot.",
    inputSchema: {
      type: "object",
      properties: { shot_id: { type: "string", description: "Shot ID" } },
      required: ["shot_id"],
    },
  },
  {
    name: "get_shot_raw_data",
    description: "Get complete raw datapoints for a shot.",
    inputSchema: {
      type: "object",
      properties: { shot_id: { type: "string", description: "Shot ID" } },
      required: ["shot_id"],
    },
  },
  {
    name: "list_profiles",
    description: "List all available espresso brew profiles.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_profile_info",
    description: "Get detailed information about a specific brew profile.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "string", description: "Profile ID" },
      },
      required: ["profile_id"],
    },
  },
  {
    name: "get_dial_in_guidance",
    description: "Get expert guidance for dialing in espresso.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "view_shot_graph",
    description:
      "Renders an interactive espresso shot graph. Shows pressure, flow, weight flow, and weight over time with target profiles overlaid. Automatically annotates key metrics (peak pressure, first drip) on the chart. Optionally compares two shots side by side — the user can also click 'Compare previous' in the graph to load the prior shot without a new tool call.",
    inputSchema: {
      type: "object",
      properties: {
        shot_id: {
          type: "string",
          description: "ID of the shot to visualize",
        },
        compare_shot_id: {
          type: "string",
          description: "Optional ID of a second shot to overlay for comparison",
        },
      },
      required: ["shot_id"],
    },
    _meta: {
      ui: { resourceUri: "ui://shot-graph/app.html" },
    },
  },
  {
    name: "get_shot_raw_json",
    description: "Get raw shot data as JSON for the shot graph UI.",
    inputSchema: {
      type: "object",
      properties: {
        shot_id: { type: "string", description: "Shot ID" },
      },
      required: ["shot_id"],
    },
    _meta: {
      ui: {
        resourceUri: "ui://shot-graph/app.html",
        visibility: ["app"],
      },
    },
  },
];

function formatStatus(status: Record<string, unknown>): string {
  const brewActive = String(status.brewSwitchState).toLowerCase() === "true";
  const steamActive = String(status.steamSwitchState).toLowerCase() === "true";
  return [
    "Gaggiuino Machine Status:",
    `  Profile: ${status.profileName ?? "N/A"}`,
    `  Temperature: ${status.temperature ?? "N/A"}°C (target: ${status.targetTemperature ?? "N/A"}°C)`,
    `  Pressure: ${status.pressure ?? "N/A"} bar`,
    `  Weight: ${status.weight ?? "N/A"} g`,
    `  Water Level: ${status.waterLevel ?? "N/A"}%`,
    `  Brew Switch: ${brewActive ? "ON" : "OFF"}`,
    `  Steam Switch: ${steamActive ? "ON" : "OFF"}`,
    `  Uptime: ${status.upTime ?? "N/A"} seconds`,
  ].join("\n");
}

function formatRawShotData(shot: Record<string, unknown>): string {
  const profile = (shot.profile ?? {}) as Record<string, unknown>;
  const globalStop = (profile.globalStopConditions ?? {}) as Record<
    string,
    unknown
  >;
  const duration = (shot.duration as number) ?? 0;
  const lines = [
    `Shot #${shot.id ?? "N/A"} Raw Data`,
    `Duration: ${(duration / 10).toFixed(1)}s`,
    "",
    "Profile:",
    `  Name: ${profile.name ?? "Unknown"}`,
  ];
  const stopParts: string[] = [];
  if (globalStop.weight !== undefined)
    stopParts.push(`weight: ${globalStop.weight}g`);
  if (globalStop.time !== undefined)
    stopParts.push(`time: ${(globalStop.time as number) / 1000}s`);
  if (stopParts.length > 0)
    lines.push(`  Stop Conditions: ${stopParts.join(", ")}`);
  lines.push("", "Datapoints:");
  const datapoints = (shot.datapoints ?? {}) as Record<string, number[]>;
  for (const [fieldName, values] of Object.entries(datapoints)) {
    if (Array.isArray(values) && values.length > 0) {
      if (SCALE_BY_10.has(fieldName)) {
        const normalized = values.map((v) => normalizeValue(v, fieldName));
        lines.push(`  ${fieldName}: ${JSON.stringify(normalized)}`);
      } else {
        lines.push(`  ${fieldName}: ${JSON.stringify(values)}`);
      }
    }
  }
  return lines.join("\n");
}

async function fetchShotSummary(shotId: string): Promise<string> {
  const shot = await getClient().getShotData(shotId);
  return formatShotSummary(generateShotSummary(shot));
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "get_status": {
      const status = await getClient().getStatus();
      return formatStatus(status as unknown as Record<string, unknown>);
    }
    case "get_latest_shot_id": {
      const shotId = await getClient().getLatestShotId();
      if (!shotId) return "No shot history available.";
      return `Latest shot ID: ${shotId}`;
    }
    case "get_shot_data": {
      return fetchShotSummary(args.shot_id as string);
    }
    case "get_shot_raw_data": {
      const shotId = args.shot_id as string;
      const shot = await getClient().getShotData(shotId);
      return formatRawShotData(shot as unknown as Record<string, unknown>);
    }
    case "list_profiles": {
      return `# Available Brew Profiles\n\n${getAllProfilesText()}`;
    }
    case "get_profile_info": {
      const profileId = args.profile_id as string;
      const profile = getProfile(profileId);
      if (!profile) {
        return `Profile '${profileId}' not found. Available: ${listProfileNames().join(", ")}`;
      }
      return [
        `# ${profile.name}`,
        "",
        `**Type:** ${profile.type}`,
        `**Best for:** ${profile.roastLevel.join(", ")} roasts`,
        `**Target ratio:** ${profile.targetRatio}`,
        `**Target time:** ${profile.targetTime}`,
        "",
        "## Description",
        "",
        profile.description,
      ].join("\n");
    }
    case "get_dial_in_guidance": {
      const prompts = loadPrompts();
      const prompt = prompts.espresso_shot_analyst;
      const profilesText = getAllProfilesText();
      const userContext = prompt.userContext ?? "";
      return prompt.template
        .replace("{user_context}", userContext)
        .replace("{profiles_text}", profilesText);
    }
    case "view_shot_graph": {
      const summary = await fetchShotSummary(args.shot_id as string);
      const parts = [summary];
      if (args.compare_shot_id) {
        parts.push(
          "",
          "---",
          "Comparison shot:",
          await fetchShotSummary(args.compare_shot_id as string),
        );
      }
      parts.push(
        "",
        `[Interactive shot graph rendered above${args.compare_shot_id ? " with comparison overlay" : ""}]`,
      );
      return parts.join("\n");
    }
    case "get_shot_raw_json": {
      const shotId = args.shot_id as string;
      const shot = await getClient().getShotData(shotId);
      return JSON.stringify(shot);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createServer() {
  const server = new Server(
    { name: "gaggiuino-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, args ?? {});
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Failed to connect")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not reach the Gaggiuino machine at ${GAGGIUINO_URL}. The machine may be powered off, asleep, or unreachable on the network. Ask the user to check that it is turned on and connected.`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Tool error: ${message}` }],
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
    if (profileMatch) {
      const profile = getProfile(profileMatch[1]);
      if (!profile) throw new Error(`Profile not found: ${profileMatch[1]}`);
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
      const htmlPath = path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "dist",
        "shot-graph",
        "app.html",
      );
      const html = await fs.readFile(htmlPath, "utf-8");
      return {
        contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: html }],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}
