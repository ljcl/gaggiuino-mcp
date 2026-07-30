import { type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  extractOutcomeMetrics,
  formatOutcomeMetrics,
  formatShotLine,
  formatShotSummary,
  generateShotSummary,
  normalizeValue,
  OutcomeMetricsSchema,
  SCALE_BY_10,
  ShotSummarySchema,
} from "./analysis";
import { getClient } from "./client";
import { MalformedUpstreamError, UpstreamHttpError } from "./errors";
import { MAX_RECENT_SHOTS, walkShotsBack } from "./history";
import { loadPrompts } from "./loader";
import {
  getAllProfilesText,
  getProfile,
  listProfileEntries,
  listProfileNames,
} from "./profiles";

/**
 * Every tool in this server reads: nothing here mutates the machine or any
 * local state. `openWorldHint` is the only honest difference between them —
 * some reach out over the network to the machine, some only read bundled YAML.
 */
const READS_MACHINE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
};

const READS_LOCAL_DATA: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

/**
 * Shot ids are opaque numeric strings minted by the machine. Hosts and models
 * routinely send them as numbers, so accept both and normalize to a string —
 * the JSON Schema advertised to the host is generated from this same schema, so
 * what is advertised is exactly what is accepted.
 */
const ShotIdSchema = z
  .union([z.string().min(1), z.number()])
  .transform(String)
  .describe(
    'Id of a shot stored on the machine, e.g. "1706547890". Call get_latest_shot_id to obtain the most recent one; ids of older shots come from a previous response.',
  );

const NoArgs = z.object({});

const ShotArgs = z.object({ shot_id: ShotIdSchema });

const MachineStatusOutput = z.object({
  brewActive: z
    .boolean()
    .describe("True while the brew switch is engaged and a shot is pulling"),
  pressureBar: z.number().describe("Current group pressure, in bar"),
  profileName: z
    .string()
    .nullable()
    .describe("Brew profile currently selected on the machine"),
  steamActive: z.boolean().describe("True while the steam switch is engaged"),
  targetTemperatureC: z
    .number()
    .nullable()
    .describe("Temperature the PID is holding for, in degrees Celsius"),
  temperatureC: z.number().describe("Current boiler temperature, in Celsius"),
  upTimeSec: z
    .number()
    .nullable()
    .describe("Seconds since the machine was last powered on"),
  waterLevelPercent: z
    .number()
    .nullable()
    .describe("Water tank level as a percentage, 0-100"),
  weightG: z
    .number()
    .nullable()
    .describe("Current reading from the scale, in grams"),
});

const LatestShotIdOutput = z.object({
  shotId: z
    .string()
    .nullable()
    .describe(
      "Id of the most recently recorded shot, or null when the machine has no shot history",
    ),
  summary: OutcomeMetricsSchema.nullable().describe(
    "Headline numbers for that shot, so the common 'how was my last shot' question needs no second call; null when there is no shot, or when the shot record itself could not be read",
  ),
});

const RecentShotsOutput = z.object({
  shots: z
    .array(OutcomeMetricsSchema)
    .describe("One entry per shot found, newest first"),
});

const ProfileOutput = z.object({
  basketNotes: z
    .string()
    .nullable()
    .describe("Basket and dose notes for this profile, when documented"),
  description: z
    .string()
    .describe("What the profile does and when to reach for it"),
  id: z.string().describe('Id to pass to get_profile_info, e.g. "zer0"'),
  name: z.string().describe("Display name as shown on the machine"),
  recommendedDose: z
    .string()
    .nullable()
    .describe("Suggested dry dose, when documented"),
  roastLevels: z
    .array(z.string())
    .describe('Roast levels this profile suits, e.g. ["light", "medium"]'),
  targetRatio: z
    .string()
    .describe('Intended brew ratio, e.g. "1:2" (dose to yield)'),
  targetTime: z.string().describe('Intended total shot time, e.g. "28-32s"'),
  type: z
    .string()
    .describe('Control strategy the profile uses, e.g. "flow" or "pressure"'),
});

const ProfileListOutput = z.object({
  profiles: z
    .array(ProfileOutput)
    .describe("Every documented profile, complete — no follow-up call needed"),
});

type ObjectSchema = z.ZodObject;

interface ErrorReply {
  isError: true;
  text: string;
}

type SuccessReply<O> = O extends ObjectSchema
  ? { structured: z.input<O>; text: string }
  : { text: string };

type ToolReply<O> = ErrorReply | SuccessReply<O>;

/** A tool as the dispatcher sees it, with its handler's argument type erased. */
export interface ToolDefinition {
  annotations: ToolAnnotations;
  description: string;
  handler: (
    input: unknown,
  ) => Promise<ErrorReply | { text: string; structured?: unknown }>;
  inputSchema: ObjectSchema;
  meta?: Record<string, unknown>;
  name: string;
  outputSchema?: ObjectSchema;
  title: string;
}

function defineTool<
  I extends ObjectSchema,
  O extends ObjectSchema | undefined = undefined,
>(spec: {
  annotations: ToolAnnotations;
  description: string;
  handler: (input: z.output<I>) => Promise<ToolReply<O>> | ToolReply<O>;
  inputSchema: I;
  meta?: Record<string, unknown>;
  name: string;
  outputSchema?: O;
  title: string;
}): ToolDefinition {
  return {
    annotations: spec.annotations,
    description: spec.description,
    handler: async (input) => spec.handler(input as z.output<I>),
    inputSchema: spec.inputSchema,
    meta: spec.meta,
    name: spec.name,
    outputSchema: spec.outputSchema,
    title: spec.title,
  };
}

/** The machine sends switch positions as the strings "true"/"false". */
function isSwitchOn(state: string | boolean | undefined): boolean {
  return String(state).toLowerCase() === "true";
}

function formatStatus(status: z.output<typeof MachineStatusOutput>): string {
  return [
    "Gaggiuino Machine Status:",
    `  Profile: ${status.profileName ?? "N/A"}`,
    `  Temperature: ${status.temperatureC}°C (target: ${status.targetTemperatureC ?? "N/A"}°C)`,
    `  Pressure: ${status.pressureBar} bar`,
    `  Weight: ${status.weightG ?? "N/A"} g`,
    `  Water Level: ${status.waterLevelPercent ?? "N/A"}%`,
    `  Brew Switch: ${status.brewActive ? "ON" : "OFF"}`,
    `  Steam Switch: ${status.steamActive ? "ON" : "OFF"}`,
    `  Uptime: ${status.upTimeSec ?? "N/A"} seconds`,
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

function toProfileOutput(
  profile: ReturnType<typeof listProfileEntries>[number],
): z.input<typeof ProfileOutput> {
  return {
    basketNotes: profile.basketNotes ?? null,
    description: profile.description,
    id: profile.id,
    name: profile.name,
    recommendedDose: profile.recommendedDose ?? null,
    roastLevels: profile.roastLevel,
    targetRatio: profile.targetRatio,
    targetTime: profile.targetTime,
    type: profile.type,
  };
}

async function summarizeShot(shotId: string): Promise<string> {
  const shot = await getClient().getShotData(shotId);
  return formatShotSummary(generateShotSummary(shot));
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  defineTool({
    annotations: READS_MACHINE,
    description:
      "Read the espresso machine's live state: boiler temperature and target, group pressure, scale weight, water level, switch positions, and uptime. Use this to answer 'is it ready', 'what profile is loaded', or 'is it low on water'. Values are instantaneous — call again for a fresh reading rather than reusing an old one.",
    handler: async () => {
      const status = await getClient().getStatus();
      const structured = {
        brewActive: isSwitchOn(status.brewSwitchState),
        pressureBar: status.pressure,
        profileName: status.profileName ?? null,
        steamActive: isSwitchOn(status.steamSwitchState),
        targetTemperatureC: status.targetTemperature ?? null,
        temperatureC: status.temperature,
        upTimeSec: status.upTime ?? null,
        waterLevelPercent: status.waterLevel ?? null,
        weightG: status.weight ?? null,
      };
      return { structured, text: formatStatus(structured) };
    },
    inputSchema: NoArgs,
    name: "get_status",
    outputSchema: MachineStatusOutput,
    title: "Get machine status",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Get the most recently recorded shot: its id, and the headline numbers for it — duration, final weight against target, peak pressure, time to first drip, temperature stability. This is the entry point for any shot question that does not already name an id, and for 'how was my last shot' it is the only call needed. Use the returned id with get_shot_data for the phase-by-phase breakdown, or with view_shot_graph to chart it.",
    handler: async () => {
      const shotId = await getClient().getLatestShotId();
      if (shotId === "") {
        return {
          structured: { shotId: null, summary: null },
          text: "No shot history available.",
        };
      }

      // The id is the answer this tool promises; the summary is a bonus that
      // saves a round trip. A shot record that cannot be read should not cost
      // the caller the id — an unreachable machine still propagates, since by
      // then the id is stale news anyway.
      let summary: z.output<typeof OutcomeMetricsSchema> | null = null;
      try {
        summary = extractOutcomeMetrics(await getClient().getShotData(shotId));
      } catch (error) {
        if (
          !(error instanceof UpstreamHttpError) &&
          !(error instanceof MalformedUpstreamError)
        ) {
          throw error;
        }
      }

      return {
        structured: { shotId, summary },
        text:
          summary === null
            ? `Latest shot ID: ${shotId}\n\nThe machine could not serve the record for this shot, so there is no summary. Ask for it again, or call get_shot_data with the id.`
            : `Latest shot ID: ${shotId}\n\n${formatOutcomeMetrics(summary)}`,
      };
    },
    inputSchema: NoArgs,
    name: "get_latest_shot_id",
    outputSchema: LatestShotIdOutput,
    title: "Get latest shot",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "List the most recent shots, newest first, each with the headline numbers: duration, final weight against target, peak pressure, time to first drip, temperature stability. Use this for questions about a run of shots — how the last five trended, whether a change helped — rather than calling get_shot_data once per id. The machine keeps a limited history and deleted shots leave gaps, so fewer shots than requested is a normal answer, not an error.",
    handler: async (input) => {
      const shots = await walkShotsBack({
        before: input.before,
        limit: input.limit,
      });
      const metrics = shots.map(extractOutcomeMetrics);
      const heading =
        input.before === undefined
          ? "# Recent shots (newest first)"
          : `# Shots before #${input.before} (newest first)`;
      const body =
        metrics.length === 0
          ? "No shots found. The machine may have no history, or none older than the id given."
          : metrics.map(formatShotLine).join("\n");
      return {
        structured: { shots: metrics },
        text: `${heading}\n\n${body}`,
      };
    },
    inputSchema: z.object({
      before: ShotIdSchema.optional().describe(
        "Only return shots older than this id. Use it to page further back, passing the oldest id from a previous response.",
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RECENT_SHOTS)
        .default(5)
        .describe(
          `How many shots to return, 1 to ${MAX_RECENT_SHOTS}. Each one is a separate request to the machine, so ask for what you need.`,
        ),
    }),
    name: "list_recent_shots",
    outputSchema: RecentShotsOutput,
    title: "List recent shots",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Summarize one shot: duration, final weight against the profile's target, peak pressure, water pumped, time to first drip, temperature stability, and a phase-by-phase breakdown with pressure/flow/weight sampled at each phase's entry, midpoint, and exit. This is the right tool for dial-in advice and for comparing shots — prefer it over get_shot_raw_data, which returns hundreds of raw samples to say the same thing.",
    handler: async (input) => {
      const shot = await getClient().getShotData(input.shot_id);
      const summary = generateShotSummary(shot);
      return { structured: summary, text: formatShotSummary(summary) };
    },
    inputSchema: ShotArgs,
    name: "get_shot_data",
    outputSchema: ShotSummarySchema,
    title: "Get shot summary",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Get every raw datapoint recorded for one shot: the full pressure, flow, weight, and temperature time series, already converted out of the machine's scaled wire format. The response is large. Only reach for it when the summary from get_shot_data is genuinely not enough — for example to inspect the exact shape of a pressure ramp.",
    handler: async (input) => {
      const shot = await getClient().getShotData(input.shot_id);
      return {
        text: formatRawShotData(shot as unknown as Record<string, unknown>),
      };
    },
    inputSchema: ShotArgs,
    name: "get_shot_raw_data",
    title: "Get raw shot datapoints",
  }),

  defineTool({
    annotations: READS_LOCAL_DATA,
    description:
      "List the documented brew profiles with their control type, suited roast levels, target ratio, and target time. Returns each profile in full, so no follow-up call is needed to describe one. These come from this server's bundled documentation, not from the machine, so a profile the user created themselves may not appear.",
    handler: () => {
      const profiles = listProfileEntries().map(toProfileOutput);
      return {
        structured: { profiles },
        text: `# Available Brew Profiles\n\n${getAllProfilesText()}`,
      };
    },
    inputSchema: NoArgs,
    name: "list_profiles",
    outputSchema: ProfileListOutput,
    title: "List brew profiles",
  }),

  defineTool({
    annotations: READS_LOCAL_DATA,
    description:
      "Get the full documentation for one brew profile, including its prose description. Call list_profiles first if you do not already have a profile id.",
    handler: (input) => {
      const profile = getProfile(input.profile_id);
      if (!profile) {
        return {
          isError: true,
          text: `No documented profile with id '${input.profile_id}'. Available ids: ${listProfileNames().join(", ")}.`,
        };
      }
      const structured = toProfileOutput({ id: input.profile_id, ...profile });
      return {
        structured,
        text: [
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
        ].join("\n"),
      };
    },
    inputSchema: z.object({
      profile_id: z
        .string()
        .min(1)
        .describe(
          'Id of a documented profile as listed by list_profiles, e.g. "zer0".',
        ),
    }),
    name: "get_profile_info",
    outputSchema: ProfileOutput,
    title: "Get brew profile details",
  }),

  defineTool({
    annotations: READS_LOCAL_DATA,
    description:
      "Get the expert system prompt for espresso dial-in: how to read a shot, which variable to change next, and the documented profiles. Call this before giving dial-in advice so the advice matches this machine and this user's setup.",
    handler: () => {
      const prompt = loadPrompts().espresso_shot_analyst;
      if (!prompt) {
        return {
          isError: true,
          text: "Dial-in guidance is not configured on this server (prompt 'espresso_shot_analyst' is missing from prompts.yaml).",
        };
      }
      return {
        text: prompt.template
          .replace("{user_context}", prompt.userContext ?? "")
          .replace("{profiles_text}", getAllProfilesText()),
      };
    },
    inputSchema: NoArgs,
    name: "get_dial_in_guidance",
    title: "Get dial-in guidance",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Renders an interactive espresso shot graph. Shows pressure, flow, weight flow, and weight over time with target profiles overlaid. Automatically annotates key metrics (peak pressure, first drip) on the chart. Optionally compares two shots side by side — the user can also click 'Compare previous' in the graph to load the prior shot without a new tool call.",
    handler: async (input) => {
      const parts = [await summarizeShot(input.shot_id)];
      if (input.compare_shot_id !== undefined) {
        parts.push(
          "",
          "---",
          "Comparison shot:",
          await summarizeShot(input.compare_shot_id),
        );
      }
      parts.push(
        "",
        `[Interactive shot graph rendered above${input.compare_shot_id !== undefined ? " with comparison overlay" : ""}]`,
      );
      return { text: parts.join("\n") };
    },
    inputSchema: z.object({
      compare_shot_id: ShotIdSchema.optional().describe(
        "Optional id of a second shot to overlay on the same axes for comparison.",
      ),
      shot_id: ShotIdSchema.describe(
        'Id of the shot to visualize, e.g. "1706547890". Call get_latest_shot_id to obtain the most recent one.',
      ),
    }),
    meta: { ui: { resourceUri: "ui://shot-graph/app.html" } },
    name: "view_shot_graph",
    title: "View shot graph",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Raw shot data as a JSON document, for the shot graph UI to plot. Not intended for the model — call get_shot_data for anything you need to reason about.",
    handler: async (input) => {
      const shot = await getClient().getShotData(input.shot_id);
      return { text: JSON.stringify(shot) };
    },
    inputSchema: ShotArgs,
    meta: {
      ui: {
        resourceUri: "ui://shot-graph/app.html",
        visibility: ["app"],
      },
    },
    name: "get_shot_raw_json",
    title: "Get raw shot JSON",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Raw data for the shot recorded before the given one, for the shot graph UI's comparison overlay. The server finds the real previous id rather than assuming ids are contiguous. Not intended for the model — call list_recent_shots to reason about a run of shots.",
    handler: async (input) => {
      const [previous] = await walkShotsBack({
        before: input.shot_id,
        limit: 1,
      });
      if (!previous) {
        return {
          isError: true,
          text: `There is no shot older than #${input.shot_id} left on the machine. Gaggiuino keeps a limited history, so the shots before this one may have already been deleted.`,
        };
      }
      return { text: JSON.stringify(previous) };
    },
    inputSchema: z.object({
      shot_id: ShotIdSchema.describe(
        "Id of the shot to look back from. The response is the newest shot older than this one.",
      ),
    }),
    meta: {
      ui: {
        resourceUri: "ui://shot-graph/app.html",
        visibility: ["app"],
      },
    },
    name: "get_previous_shot_json",
    title: "Get previous shot JSON",
  }),
];

export const TOOLS_BY_NAME = new Map(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);
