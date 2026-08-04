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
import { getClient, type MachineMaintenance } from "./client";
import { MalformedUpstreamError, UpstreamHttpError } from "./errors";
import { MISSING_GUIDANCE_TEXT, renderDialInGuidance } from "./guidance";
import { MAX_RECENT_SHOTS, walkShotsBack } from "./history";
import { extractServiceHistory, formatMaintenance } from "./maintenance";
import { loadSecurityConfig } from "./mcpAuth";
import {
  type CatalogEntry,
  findCatalogEntry,
  loadProfileCatalog,
  type ProfileCatalog,
} from "./profileCatalog";

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
 * The one tool that changes the machine.
 *
 * `readOnlyHint: false` is what tells a host to treat this differently from
 * everything else here — it is the signal an approval prompt is keyed on, and
 * claiming otherwise to avoid the prompt would be the dishonest annotation this
 * repo's tests exist to catch.
 *
 * `destructiveHint: false` and `idempotentHint: true` are equally literal:
 * selecting a profile replaces a selection rather than destroying anything, and
 * selecting the same one twice leaves the machine exactly where selecting it
 * once did. Nothing about the shot history changes.
 */
const WRITES_MACHINE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
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

/**
 * Every documentation-derived field is nullable, because a profile the user
 * built on the machine is real and selectable and has none of them. Before the
 * machine was the source of truth those fields could be required; a schema that
 * still required them would force the merge to drop exactly the profiles the
 * user cares most about.
 */
const ProfileOutput = z.object({
  basketNotes: z
    .string()
    .nullable()
    .describe("Basket and dose notes for this profile, when documented"),
  description: z
    .string()
    .nullable()
    .describe(
      "What the profile does and when to reach for it; null for a profile this server has no documentation for",
    ),
  documented: z
    .boolean()
    .describe("Whether this server holds curated documentation for it"),
  id: z.string().describe('Id to pass to get_profile_info, e.g. "zer0"'),
  machineProfileId: z
    .string()
    .nullable()
    .describe(
      "Id the machine knows this profile by, and the one select_profile takes; null when the profile is not on the machine or the machine did not supply one",
    ),
  name: z.string().describe("Display name as shown on the machine"),
  onMachine: z
    .boolean()
    .nullable()
    .describe(
      "True when the machine reported this profile, false when it did not, null when the machine could not be reached to ask",
    ),
  recommendedDose: z
    .string()
    .nullable()
    .describe("Suggested dry dose, when documented"),
  roastLevels: z
    .array(z.string())
    .describe(
      'Roast levels this profile suits, e.g. ["light", "medium"]; empty when undocumented',
    ),
  targetRatio: z
    .string()
    .nullable()
    .describe('Intended brew ratio, e.g. "1:2" (dose to yield)'),
  targetTime: z
    .string()
    .nullable()
    .describe('Intended total shot time, e.g. "28-32s"'),
  type: z
    .string()
    .nullable()
    .describe('Control strategy the profile uses, e.g. "flow" or "pressure"'),
});

const ProfileListOutput = z.object({
  note: z
    .string()
    .describe(
      "Where this list came from, and any caveat that applies to reading it",
    ),
  profiles: z
    .array(ProfileOutput)
    .describe(
      "Every profile, complete — no follow-up call needed. Machine profiles first, documented-but-absent ones last",
    ),
  source: z
    .enum(["documentation", "machine"])
    .describe(
      "'machine' when the machine answered, 'documentation' when this server fell back to its bundled docs",
    ),
});

/**
 * One service the machine keeps a log for.
 *
 * The *list* of services is not modelled — see `maintenance.ts` — so this
 * describes the shape of a record and `services` carries however many the
 * firmware sent. That is the difference from `get_machine_settings`, which is
 * text-only precisely because a schema there would have to enumerate
 * firmware-chosen fields and would drop the new one. A firmware that starts
 * tracking a water-filter change appears here with no change to this schema.
 */
const ServiceHistoryOutput = z.object({
  lastAt: z
    .string()
    .nullable()
    .describe(
      "When the machine last recorded this service, as an ISO-8601 UTC instant. Null when it has never recorded one — the machine reports 0 for that, which is not 1 January 1970 — or when the epoch it reported is too early to be a real date, which means its clock was not set at the time.",
    ),
  lastEpochSec: z
    .number()
    .nullable()
    .describe(
      "The same instant in the machine's own epoch seconds, or null when it has never recorded this service.",
    ),
  service: z
    .string()
    .describe(
      'Which service this is, in the machine\'s own naming: "descale" or "backflush" on current firmware.',
    ),
  shotsSince: z
    .number()
    .nullable()
    .describe(
      "Shots recorded since that service. Only shots that ran long enough for the machine to record them — 5 seconds — are counted, so flushes and aborted pulls are not in this number. Null when this firmware reports no counter for the service.",
    ),
});

const MaintenanceOutput = z.object({
  services: z
    .array(ServiceHistoryOutput)
    .describe(
      "One entry per service this firmware tracks, in the order the machine reported them. Empty means the machine's service log is empty, which is different from the firmware having no service log at all — that comes back as an error result.",
    ),
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

function formatProfileLine(entry: CatalogEntry): string {
  const lines = [`### ${entry.name} (\`${entry.id}\`)`];
  if (entry.onMachine === false) {
    lines.push("- **Not currently on the machine** (documented here only)");
  }
  if (entry.machineProfileId !== null) {
    lines.push(`- Machine profile id: ${entry.machineProfileId}`);
  }
  if (!entry.documented) {
    lines.push("- No documentation on this server; created on the machine");
    return lines.join("\n");
  }
  lines.push(
    `- Type: ${entry.type}`,
    `- Best for: ${entry.roastLevels.join(", ")} roasts`,
    `- Target ratio: ${entry.targetRatio}`,
    `- Target time: ${entry.targetTime}`,
  );
  return lines.join("\n");
}

function formatCatalog(catalog: ProfileCatalog): string {
  return [
    "# Brew Profiles",
    "",
    catalog.note,
    "",
    ...catalog.entries.map(formatProfileLine).flatMap((block) => [block, ""]),
  ].join("\n");
}

const HIDDEN_VALUE = "[hidden]";
const UNSET_VALUE = "(not set)";

const HIDDEN_VALUE_NOTE =
  "Values shown as [hidden] are withheld by this MCP server, not missing from the machine. The machine's settings carry upload tokens and an MQTT password, so a text value is printed only when this server can tell it is not a credential: numbers, true/false, and a short list of known-safe fields. Read a hidden value on the machine's own settings screen.";

/**
 * Names never printed, whatever else says otherwise — the second, independent
 * layer under the value-type rule below, so a careless future addition to
 * `PRINTABLE_TEXT_SETTINGS` still cannot leak.
 */
const SECRET_KEY_PATTERN =
  /token|password|passwd|secret|api[_-]?key|credential|bearer|private[_-]?key/i;

/** The only free-form text settings printed verbatim. Everything else is hidden. */
const PRINTABLE_TEXT_SETTINGS = new Set([
  "btscalespinnedmac",
  "coreversion",
  "frontversion",
  "mqtthost",
  "mqtttopicprefix",
  "staticversion",
]);

/**
 * Whether a settings value can be printed, decided by its **type** rather than
 * by its name.
 *
 * `/api/settings` is an aggregate, and the `system` section inside it carries
 * `sprofilerToken`, `visualizerToken`, `mqttUsername`, and `mqttPassword`
 * (`docs/upstream/rest-api.md` L182-183, L193-194). This function used to be
 * `String(value)`, so every one of them went straight into model context.
 *
 * A denylist of those four names is the obvious fix and the wrong one: it
 * misses `newUploadToken`, `visualizerAuth`, `mqttPsk` — anything a later
 * firmware names differently — and it fails *silently*, which is how the
 * original defect survived. Defaulting on type inverts that. Numbers, booleans,
 * and this firmware's string-encoded numbers and booleans are never credentials
 * and print unconditionally; a free-form string is hidden unless it is on a
 * short allowlist, because in this particular payload four of the documented
 * free-form strings are secrets.
 *
 * An empty string prints `(not set)` rather than `[hidden]`, so "no MQTT
 * password is configured" stays distinguishable from "one exists and is
 * withheld".
 *
 * Residual hole, recorded rather than hidden: a credential whose key matches no
 * pattern *and* whose value is entirely numeric would print. Closing that would
 * mean hiding `mqttPort` and every setpoint, and real tokens are alphanumeric —
 * the reference's own examples (`abc123xyz`, `def456uvw`) are.
 */
function renderSettingValue(
  key: string,
  value: unknown,
  forceHidden: boolean,
): string {
  // Numbers, booleans, null and undefined in one branch: JSON has no other
  // scalar, so nothing reaches the string rules below by accident.
  if (typeof value !== "string") return String(value);
  if (value === "") return UNSET_VALUE;
  if (forceHidden || SECRET_KEY_PATTERN.test(key)) return HIDDEN_VALUE;
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return value;
  if (Number.isFinite(Number(trimmed))) return value;
  if (PRINTABLE_TEXT_SETTINGS.has(key.toLowerCase())) return value;
  return HIDDEN_VALUE;
}

/**
 * Settings are printed rather than modelled. Which knobs a build exposes is a
 * firmware decision, and a hand-written schema would silently drop the one a
 * newer build added — which is the field a user asking about settings is most
 * likely to be asking about.
 *
 * Every key still prints, with its nesting, whatever happens to its value. That
 * is what makes this redaction rather than dropping: the user learns the setting
 * exists and is told why the value is absent.
 *
 * `forceHidden` propagates into a whole subtree so a future
 * `credentials: { visualizer: "…" }` is covered by its *section* name without
 * anyone having to notice the leaf.
 */
function formatSettings(
  settings: Record<string, unknown>,
  indent = "  ",
  forceHidden = false,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (value !== null && typeof value === "object") {
      lines.push(
        `${indent}${key}:`,
        ...formatSettings(
          value as Record<string, unknown>,
          `${indent}  `,
          forceHidden || SECRET_KEY_PATTERN.test(key),
        ),
      );
    } else {
      lines.push(
        `${indent}${key}: ${renderSettingValue(key, value, forceHidden)}`,
      );
    }
  }
  return lines;
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
    annotations: READS_MACHINE,
    description:
      "List the brew profiles on the machine, each merged with this server's documentation for it — control type, suited roast levels, target ratio, target time. Returns each profile in full, so no follow-up call is needed to describe one. A profile the user built on the machine appears with its documentation fields null; a profile this server documents that is not currently loaded appears with onMachine false. If the machine cannot be reached the bundled documentation is returned instead, and 'source' and 'note' say so.",
    handler: async () => {
      const catalog = await loadProfileCatalog();
      return {
        structured: {
          note: catalog.note,
          profiles: catalog.entries,
          source: catalog.source,
        },
        text: formatCatalog(catalog),
      };
    },
    inputSchema: NoArgs,
    name: "list_profiles",
    outputSchema: ProfileListOutput,
    title: "List brew profiles",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Get everything known about one brew profile: whether it is on the machine, the id select_profile would take, and its prose documentation when this server has any. Accepts a documented id, a machine profile id, or the profile's name. Call list_profiles first if you do not already have one.",
    handler: async (input) => {
      const { catalog, entry } = await findCatalogEntry(input.profile_id);
      if (!entry) {
        return {
          isError: true,
          text: `No profile matching '${input.profile_id}'. Available ids: ${catalog.entries.map((candidate) => candidate.id).join(", ")}.`,
        };
      }
      const lines = [`# ${entry.name}`, ""];
      if (entry.onMachine === false) {
        lines.push(
          "**Not currently on the machine.** This server documents it, but the machine did not report it.",
          "",
        );
      }
      if (entry.machineProfileId !== null) {
        lines.push(`**Machine profile id:** ${entry.machineProfileId}`, "");
      }
      if (entry.documented) {
        lines.push(
          `**Type:** ${entry.type}`,
          `**Best for:** ${entry.roastLevels.join(", ")} roasts`,
          `**Target ratio:** ${entry.targetRatio}`,
          `**Target time:** ${entry.targetTime}`,
          "",
          "## Description",
          "",
          entry.description ?? "",
        );
      } else {
        lines.push(
          "This profile was created on the machine, so this server has no documentation for it. Read its behaviour from a shot pulled with it — get_shot_data reports the phases the profile actually ran.",
        );
      }
      return { structured: entry, text: lines.join("\n") };
    },
    inputSchema: z.object({
      profile_id: z
        .string()
        .min(1)
        .describe(
          'Id, machine profile id, or name of a profile as listed by list_profiles, e.g. "zer0".',
        ),
    }),
    name: "get_profile_info",
    outputSchema: ProfileOutput,
    title: "Get brew profile details",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Read the machine's configuration: boiler and steam setpoints, temperature offset, scale and predictive-stop settings, and whatever else this firmware exposes. Useful as dial-in context — a brew temperature that never matches the profile usually shows up here as an offset rather than in the shot data. The fields are whatever the machine sends, so treat unfamiliar names as firmware-specific.",
    handler: async () => {
      const settings = await getClient().getSettings();
      const lines = formatSettings(settings);
      // The footer is emitted only when something was actually withheld, so a
      // machine with no credentials configured gets no paragraph explaining a
      // redaction that did not happen.
      const hidAnything = lines.some((line) => line.endsWith(HIDDEN_VALUE));
      return {
        text: [
          "Gaggiuino Settings:",
          ...lines,
          ...(hidAnything ? ["", HIDDEN_VALUE_NOTE] : []),
        ].join("\n"),
      };
    },
    inputSchema: NoArgs,
    name: "get_machine_settings",
    title: "Get machine settings",
  }),

  defineTool({
    annotations: READS_MACHINE,
    description:
      "Read the service history the machine tracks for itself: when it last recorded a descale and a backflush, and how many shots it has pulled since each. Reach for it when the shot data points at the machine rather than the coffee — scale build-up shows up as flow that will not match the profile's targets and a brew temperature that will not hold, at a grind setting that used to work. The machine records a descale at 50% of the descale cycle and a backflush once pressure holds above 10 bar in flush mode for more than two seconds, so a service done by hand is not in these numbers, and the shot counters only count shots that ran 5 seconds or longer. Older firmware does not track any of this and says so.",
    handler: async () => {
      let raw: MachineMaintenance;
      try {
        raw = await getClient().getMaintenance();
      } catch (error) {
        // Older firmware has no service log at all. That is a definitive answer
        // to "when did I last descale", not a machine fault — and the generic
        // 404 text in errors.ts ("has no endpoint at /api/maintenance … running
        // a firmware version that does not expose it") reads as a bug report
        // rather than as an answer. Handled here, at the one call site that
        // knows what that path means, so errors.ts gains no per-endpoint branch.
        if (error instanceof UpstreamHttpError && error.status === 404) {
          return {
            isError: true,
            text: "This machine's firmware does not track service history — it has no /api/maintenance endpoint. Nothing is wrong with the machine; the Service Log is a newer firmware feature. Ask the user when they last descaled and backflushed, or suggest updating the firmware.",
          };
        }
        throw error;
      }
      const reading = extractServiceHistory(raw);
      return {
        structured: { services: reading.services },
        text: formatMaintenance(reading, Date.now()),
      };
    },
    inputSchema: NoArgs,
    name: "get_maintenance_status",
    outputSchema: MaintenanceOutput,
    title: "Get machine service history",
  }),

  defineTool({
    annotations: WRITES_MACHINE,
    description:
      "Switch the machine to a different brew profile. This changes the machine, so confirm the profile with the user before calling it — do not select one on your own initiative from dial-in advice. Takes the id from list_profiles (either the documented id or the machineProfileId). The profile must already be on the machine; this cannot create one. Refuses unless this server is configured with an auth token, since an unauthenticated server exposed over a tunnel would let anyone reach it.",
    handler: async (input) => {
      // The gate is the token, not the origin allowlist: origin validation
      // stops a browser on another site from calling us, but it does not
      // authenticate anybody. An open /mcp is fine for tools that only read a
      // shot history; it is not fine for one that touches the machine.
      if (loadSecurityConfig().token === undefined) {
        return {
          isError: true,
          text: "Profile selection is disabled because this server has no MCP_AUTH_TOKEN set, so its /mcp endpoint is unauthenticated. Every other tool here only reads. Ask the user to set MCP_AUTH_TOKEN (see the README's 'Securing the endpoint' section) and restart the server, or to change the profile on the machine itself.",
        };
      }

      const { catalog, entry } = await findCatalogEntry(input.profile_id);
      if (!entry) {
        return {
          isError: true,
          text: `No profile matching '${input.profile_id}'. Available ids: ${catalog.entries.map((candidate) => candidate.id).join(", ")}.`,
        };
      }
      if (entry.machineProfileId === null) {
        return {
          isError: true,
          text:
            catalog.source === "machine"
              ? `'${entry.name}' is documented on this server but is not loaded on the machine, so it cannot be selected. Ask the user to add it on the machine first. Call list_profiles to see what is currently loaded.`
              : `The machine could not be reached, so this server does not know the id '${entry.name}' has on it and cannot select it. ${catalog.note}`,
        };
      }

      await getClient().selectProfile(entry.machineProfileId);
      return {
        text: `Selected profile '${entry.name}' (machine profile id ${entry.machineProfileId}). Call get_status to confirm the machine is reporting it, and give it a moment to come back up to temperature before the next shot.`,
      };
    },
    inputSchema: z.object({
      profile_id: z
        .string()
        .min(1)
        .describe(
          'Id of the profile to select, as listed by list_profiles — either its documented id ("zer0") or its machineProfileId ("15").',
        ),
    }),
    name: "select_profile",
    title: "Select brew profile",
  }),

  defineTool({
    annotations: READS_LOCAL_DATA,
    description:
      "Get the expert system prompt for espresso dial-in: how to read a shot, which variable to change next, and the documented profiles. Call this before giving dial-in advice so the advice matches this machine and this user's setup.",
    handler: () => {
      const guidance = renderDialInGuidance();
      if (guidance === undefined) {
        return { isError: true, text: MISSING_GUIDANCE_TEXT };
      }
      return { text: guidance };
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
