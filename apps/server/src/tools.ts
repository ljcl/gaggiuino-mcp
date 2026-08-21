import { type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  extractOutcomeMetrics,
  formatOutcomeMetrics,
  formatShotLine,
  formatShotSummary,
  generateShotSummary,
  OutcomeMetricsSchema,
  ShotSummarySchema,
} from "./analysis";
import {
  type CreatedProfile,
  getClient,
  type MachineMaintenance,
} from "./client";
import {
  MalformedUpstreamError,
  UpstreamHttpError,
  UpstreamUnreachableError,
} from "./errors";
import { MISSING_GUIDANCE_TEXT, renderDialInGuidance } from "./guidance";
import { MAX_RECENT_SHOTS, walkShotsBack } from "./history";
import { extractServiceHistory, formatMaintenance } from "./maintenance";
import { loadSecurityConfig } from "./mcpAuth";
import { normalizeValue, SCALE_BY_10 } from "./normalize";
import {
  type CatalogEntry,
  findCatalogEntry,
  loadProfileCatalog,
  type ProfileCatalog,
} from "./profileCatalog";
import {
  formatProfileDefinition,
  loadProfileDefinition,
  ProfileDefinitionOutput,
} from "./profileDefinition";
import { PHASE_TYPES, TRANSITION_CURVES } from "./profileShape";

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
 * A tool that changes the machine, and can safely be repeated.
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
 * A write that is not safe to repeat.
 *
 * `POST /api/profile` mints a fresh id on every call — the machine's own
 * documentation says so — so uploading the same profile twice leaves two
 * profiles. `idempotentHint: false` is the honest annotation, it is the reason
 * this tool does not inherit `client.ts`'s retry loop, and it is the flag a host
 * would key an automatic retry on.
 *
 * `destructiveHint: false` is a judgement rather than an oversight: a create is
 * additive, it cannot overwrite or delete an existing profile, and REST offers
 * no update verb at all (editing a saved profile is `c_upd_prof` over the
 * WebSocket API, which this server does not speak). An unwanted profile is
 * removable on the machine; that is friction, not destruction.
 */
const CREATES_ON_MACHINE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

/**
 * The only tool here that destroys something, and the only one that can.
 *
 * `destructiveHint: true` is the first in this server, and it is literal rather
 * than cautious: `DELETE /api/profile-select/{id}` removes a saved profile and
 * there is no restore path. `upload_profile` cannot rebuild a definition nobody
 * read before deleting it, so the loss is permanent from this server's side.
 *
 * **`idempotentHint` is deliberately absent rather than set either way.**
 * Deleting twice reaching the same end state is only true if ids are stable
 * across a delete, and the reference says nothing about whether they are reused
 * or renumbered (rest-api.md L41-44 is three lines with no response body and no
 * status codes). Claiming `true` would invite a host to retry, and a retry whose
 * first attempt landed could remove a *different* profile. Claiming `false`
 * would assert a non-idempotence nobody has observed. Absent is the honest
 * answer to a question nobody has asked the hardware, and it reads as the
 * protocol default — which is the conservative one.
 */
const DELETES_ON_MACHINE: ToolAnnotations = {
  destructiveHint: true,
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

/**
 * What `get_profile_info` adds over a list row: the machine's own definition,
 * fetched per profile.
 *
 * Deliberately an extension rather than a widened `ProfileOutput`.
 * `list_profiles` shares that schema, so widening it in place would re-key
 * **two** host permission grants instead of one — and it would imply one
 * upstream request per profile in a list, against a device that serves one
 * request at a time.
 */
const ProfileDetailOutput = ProfileOutput.extend({
  definition: ProfileDefinitionOutput.nullable().describe(
    "The profile as the machine itself stores it: brew temperature, phases with their targets and stop conditions, recipe, and what ends the shot. This is the machine's own wire format — milliseconds, real degrees Celsius — so it can be edited and handed straight to upload_profile. Null when the profile is not on the machine, or when the machine did not serve one; definitionNote says which.",
  ),
  definitionNote: z
    .string()
    .describe("Where the definition came from, or why there is none"),
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
 * A profile on its way *to* the machine — the one strict schema in this server,
 * and the inversion is deliberate.
 *
 * Every schema in `client.ts` is loose because it parses bytes the **machine**
 * sent, where a firmware revision must not take the server down. This one parses
 * bytes a **language model** wrote, heading for persistence on the user's
 * machine, where the reference says *"other missing/malformed fields are filled
 * with zero-value defaults"* (`docs/upstream/rest-api.md` L81). A stripped
 * unknown key is therefore not a harmless no-op — it is a phase that silently
 * targets 0. `strictObject` turns that into `Unrecognized key` with the full
 * path, which a model can fix, and `z.toJSONSchema(..., { io: "input" })` emits
 * `additionalProperties: false` so the rule is advertised as well as enforced.
 *
 * **Units are the profile's own and are NOT the x10 wire format.** `SCALE_BY_10`
 * describes shot *datapoints*; a profile's times are milliseconds and its
 * temperatures real degrees. The `.max()` bounds are there mostly to catch that
 * confusion in the direction it actually happens: a model that has just read a
 * shot has `pressure: 91` and `temperature: 910` in front of it, and `.max(20)`
 * and `.max(110)` reject both rather than writing a profile that asks for 91 bar
 * at 910°C.
 *
 * The `.refine` below is enforced but **not advertised** — `z.toJSONSchema`
 * cannot represent it and drops it silently — so `target`'s own description has
 * to carry the rule.
 */
const TransitionInput = z.strictObject({
  curve: z
    .enum(TRANSITION_CURVES)
    .optional()
    .describe(
      "How the target moves from start to end over `time`. Omit for the machine's default; INSTANT steps straight to `end`.",
    ),
  end: z
    .number()
    .min(0)
    .max(20)
    .describe(
      "Value to arrive at: bar for a PRESSURE phase, ml/s for a FLOW phase. Real units — 9 means 9 bar, not the x10-scaled 90 a shot's pressure datapoint reports.",
    ),
  start: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe(
      "Value to start from, same units as `end`. Omit to continue from where the previous phase ended.",
    ),
  time: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .describe(
      "How long the move from start to end takes, in MILLISECONDS (5000 = 5 seconds). Omit or 0 to step straight to `end`.",
    ),
  volume: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Optional millilitre budget for the transition. Leave unset unless copying a profile that uses it.",
    ),
});

const PhaseStopConditionsInput = z.strictObject({
  flowAbove: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe("End the phase once pump flow rises above this, in ml/s."),
  flowBelow: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe("End the phase once pump flow falls below this, in ml/s."),
  pressureAbove: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe("End the phase once group pressure rises above this, in bar."),
  pressureBelow: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe("End the phase once group pressure falls below this, in bar."),
  time: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .describe(
      "End the phase after this long, in MILLISECONDS (10000 = 10 seconds).",
    ),
  waterPumpedInPhase: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "End the phase once this many millilitres have been pumped during it. The machine's documentation does not state the unit; millilitres is inferred from the flow units.",
    ),
  weight: z
    .number()
    .min(0)
    .max(500)
    .optional()
    .describe("End the phase once the scale reads this many grams."),
});

const PhaseInput = z
  .strictObject({
    name: z
      .string()
      .max(64)
      .optional()
      .describe('Label shown on the machine, e.g. "Preinfusion".'),
    restriction: z
      .number()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "Flow restriction for the phase; 0 is unrestricted. The machine's documentation does not state its unit, so leave it at 0 unless copying a profile that sets it.",
      ),
    skip: z
      .boolean()
      .optional()
      .describe("True to keep the phase in the profile but not run it."),
    stopConditions: PhaseStopConditionsInput.optional().describe(
      "What ends this phase. Omit only for a final phase meant to run until a global stop condition fires — a phase with neither runs until the brew switch is released.",
    ),
    target: TransitionInput.optional().describe(
      "Where the phase drives pressure or flow to, and how fast. Required for a FLOW or PRESSURE phase.",
    ),
    type: z
      .enum(PHASE_TYPES)
      .describe(
        "What the phase controls: PRESSURE holds a pressure target, FLOW holds a flow target, MANUAL hands control to the machine's own sliders.",
      ),
    waterTemperature: z
      .number()
      .min(0)
      .max(110)
      .optional()
      .describe(
        "Per-phase brew temperature override, in degrees Celsius. Omit to use the profile's own waterTemperature.",
      ),
  })
  .refine((phase) => phase.type === "MANUAL" || phase.target !== undefined, {
    error:
      "a FLOW or PRESSURE phase needs a target — without one the machine fills it with a zero-value default, i.e. a phase that targets 0",
    path: ["target"],
  });

const GlobalStopConditionsInput = z.strictObject({
  switchToManuaFlowCtrl: z
    .boolean()
    .optional()
    .describe(
      "Switch to manual flow control instead of stopping. Spelled exactly as the firmware spells it, with one 'l' in 'Manua' — that misspelling is the machine's wire format, not a typo here.",
    ),
  switchToManualPressureCtrl: z
    .boolean()
    .optional()
    .describe("Switch to manual pressure control instead of stopping."),
  time: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .describe(
      "Stop the shot after this long, in MILLISECONDS (40000 = 40 seconds).",
    ),
  waterPumped: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe("Stop once this many millilitres have been pumped."),
  weight: z
    .number()
    .min(0)
    .max(500)
    .optional()
    .describe(
      "Stop once the scale reads this many grams — the usual way to end a shot on a machine with scales.",
    ),
});

const BrewRecipeInput = z.strictObject({
  coffeeIn: z
    .number()
    .min(0)
    .max(200)
    .optional()
    .describe("Dry dose, in grams."),
  coffeeOut: z
    .number()
    .min(0)
    .max(500)
    .optional()
    .describe("Target yield, in grams."),
  ratio: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe(
      "Yield divided by dose; 2 means 1:2. Informational — the machine does not enforce it.",
    ),
});

const ProfileUploadInput = z.strictObject({
  globalStopConditions: GlobalStopConditionsInput.optional().describe(
    "What ends the whole shot, whichever phase is running.",
  ),
  name: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Name the profile appears under on the machine. Give a copy a distinct name — the machine does not enforce unique names, and two profiles called the same thing are indistinguishable on its screen.",
    ),
  phases: z
    .array(PhaseInput)
    .min(1)
    .max(20)
    .describe(
      "The phases the shot runs, in order. The machine requires at least one.",
    ),
  recipe: BrewRecipeInput.optional().describe(
    "Dose and yield the profile is written for. Informational.",
  ),
  waterTemperature: z
    .number()
    .min(0)
    .max(110)
    .describe(
      "Brew temperature in degrees Celsius, e.g. 93. Real degrees — not the x10-scaled 930 a shot's temperature datapoint reports. Required here even though the machine would default it to 0, because a profile that brews at 0°C is not a profile.",
    ),
});

const ProfileUploadOutput = z.object({
  machineProfileId: z
    .string()
    .nullable()
    .describe(
      "Id the machine assigned the new profile — the value select_profile takes. Null when the machine saved the profile but its answer carried no id; call list_profiles to find it in that case.",
    ),
  name: z.string().describe("Name the profile was saved under."),
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

/**
 * The gate every tool that changes the machine sits behind.
 *
 * The gate is a credential, not the origin allowlist: origin validation stops a
 * browser on another site from calling us, but it does not authenticate
 * anybody. An open `/mcp` is fine for tools that read a shot history; it is not
 * fine for one that touches the machine.
 *
 * This is the third of three states, and the only one a tool handler ever sees.
 * With OAuth configured, a caller with no token or the wrong scope is refused at
 * the HTTP layer with a 401 or 403 (`http.ts`), because only a status code
 * produces an authentication prompt. What is left for this function is the case
 * where there is no way to authenticate at all — and *that* must not be a 401,
 * because a 401 pointing at metadata that does not exist is what produces
 * Anthropic's "Couldn't reach the MCP server." An `isError` explaining the
 * situation is the honest answer, and the model can relay it.
 */
function writeToolDisabled(action: string): ErrorReply | undefined {
  if (loadSecurityConfig().oauth !== undefined) return undefined;
  return {
    isError: true,
    // "the three that change the machine" rather than a count that has already
    // been wrong once: this sentence said "the two" until `delete_profile`
    // landed, and nothing asserted it, so it was simply false in the model's
    // context. A fourth write tool must update it again.
    text: `${action} is disabled because this server has no way to authenticate anyone: its /mcp endpoint is open. Every tool here other than the three that change the machine only reads. Ask the user to configure OAuth by setting MCP_PUBLIC_URL and MCP_OAUTH_SECRET (see the README's 'Securing the endpoint' section) and restart the server, or to make the change on the machine itself.`,
  };
}

/**
 * What to tell the user when an upload did not come back clean.
 *
 * Handled here rather than in `errors.ts` because `describeUpstreamError`'s
 * generic branches give advice that is actively wrong for a create: the 5xx
 * branch ends "then retry", and the unreachable branch says "the machine may be
 * powered off" about a request that may have been applied. Retrying a create
 * that already landed is how a user ends up with two profiles.
 *
 * Returns `undefined` for anything that is not an upstream failure, so the
 * dispatcher's generic path still catches genuine bugs — the same contract
 * `describeUpstreamError` has, kept local because the advice is specific.
 * `MalformedUpstreamError` is deliberately absent: `createdProfileReader`
 * cannot raise one.
 */
export function describeUploadFailure(
  error: unknown,
  profileName: string,
): ErrorReply | undefined {
  if (error instanceof UpstreamUnreachableError) {
    return {
      isError: true,
      text: `The machine did not answer while saving '${profileName}', so this server cannot tell you whether the profile was saved or not — the request may have been applied before the connection failed. Call list_profiles and look for '${profileName}' before calling upload_profile again: a second upload would create a second profile, because the machine assigns a fresh id every time.`,
    };
  }
  if (error instanceof UpstreamHttpError) {
    const machineSaid = error.detail
      ? ` The machine said: ${error.detail}`
      : "";
    if (error.status === 404) {
      return {
        isError: true,
        text: `This machine's firmware has no profile-upload endpoint (HTTP 404 for ${error.path}). Nothing was saved. The user would need to update the machine's firmware, or build the profile on the machine itself.`,
      };
    }
    if (error.status === 422 || error.status === 400) {
      return {
        isError: true,
        text: `The machine rejected the profile and saved nothing (HTTP ${error.status}).${machineSaid} It requires a name and at least one phase. Fix the profile and call upload_profile again — this failure is safe to repeat, because nothing was created.`,
      };
    }
    return {
      isError: true,
      text: `The machine returned HTTP ${error.status} (${error.statusText}) while saving '${profileName}'.${machineSaid} That usually means the profile could not be written to storage, but this server cannot confirm nothing was saved. Call list_profiles to check before uploading again — do not simply repeat the call, because a second upload would create a second profile.`,
    };
  }
  return undefined;
}

/**
 * What to tell the user when a delete did not come back clean.
 *
 * Local for `describeUploadFailure`'s reason and one more. `errors.ts`'s
 * `profileIdFromPath` matches `/api/profile-select/<id>` **regardless of HTTP
 * method**, so the generic 404 branch already produces text naming
 * `select_profile` and telling the caller to go find the right
 * `machineProfileId` — advice for the wrong verb, and wrong about what happened.
 * Fixing that in `errors.ts` would mean teaching it about methods; keeping it
 * here matches how `profileDefinition.ts` handles its own ambiguous 404.
 *
 * A 404 on a delete is genuinely ambiguous — the profile may never have existed
 * under that id, or it may have been deleted already, by this call's own first
 * attempt or by someone at the machine. The text says both rather than picking,
 * and points at the one tool that can settle it.
 */
export function describeDeleteFailure(
  error: unknown,
  profileName: string,
): ErrorReply | undefined {
  if (error instanceof UpstreamUnreachableError) {
    return {
      isError: true,
      text: `The machine did not answer while deleting '${profileName}', so this server cannot tell you whether the profile was deleted or not — the request may have been applied before the connection failed. Call list_profiles and look for '${profileName}'. Do not simply repeat the delete: the machine's documentation does not say whether profile ids are reused after one is removed, so a second delete against the same id could remove a different profile.`,
    };
  }
  if (error instanceof UpstreamHttpError) {
    const machineSaid = error.detail
      ? ` The machine said: ${error.detail}`
      : "";
    if (error.status === 404) {
      return {
        isError: true,
        text: `The machine answered 404 for '${profileName}' (${error.path}). That means one of two things and this server cannot tell them apart: the profile was already gone, or this firmware has no delete endpoint. Call list_profiles — if '${profileName}' is absent it is deleted and there is nothing more to do; if it is still listed, this firmware cannot delete profiles over the API and the user needs to remove it on the machine itself.`,
      };
    }
    return {
      isError: true,
      text: `The machine returned HTTP ${error.status} (${error.statusText}) while deleting '${profileName}'.${machineSaid} This server cannot confirm whether the profile was removed. Call list_profiles to check — do not simply repeat the delete, because the machine's documentation does not say whether ids are reused after a profile is removed.`,
    };
  }
  return undefined;
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
      "Get everything known about one brew profile: the machine's own definition of it — brew temperature, the phases it runs with their targets and stop conditions, and the recipe it was written around — plus this server's prose documentation when it has any, whether the profile is on the machine, and the id select_profile takes. This is the right tool for 'what does this profile actually do', including a profile the user built themselves. The definition comes back in the machine's own wire format, so it can be edited and handed to upload_profile. Accepts a documented id, a machine profile id, or the profile's name. Call list_profiles first if you do not already have one. Firmware that predates the machine's per-profile export answers with the documentation alone and says so.",
    handler: async (input) => {
      const { catalog, entry } = await findCatalogEntry(input.profile_id);
      if (!entry) {
        return {
          isError: true,
          text: `No profile matching '${input.profile_id}'. Available ids: ${catalog.entries.map((candidate) => candidate.id).join(", ")}.`,
        };
      }
      const definition = await loadProfileDefinition(entry, catalog);
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
          "This profile was created on the machine, so this server has no curated documentation for it — what the machine itself stores is below. For how it actually behaved in the cup, call get_shot_data on a shot pulled with it.",
        );
      }
      lines.push("", ...formatProfileDefinition(definition));
      return {
        structured: {
          ...entry,
          definition: definition.definition,
          definitionNote: definition.note,
        },
        text: lines.join("\n"),
      };
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
    outputSchema: ProfileDetailOutput,
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
      "Switch the machine to a different brew profile. This changes the machine, so confirm the profile with the user before calling it — do not select one on your own initiative from dial-in advice. Takes the id from list_profiles (either the documented id or the machineProfileId). The profile must already be on the machine; this cannot create one. Refuses unless this server has an authorization server configured, since an unauthenticated server exposed over a tunnel would let anyone reach it.",
    handler: async (input) => {
      const denied = writeToolDisabled("Profile selection");
      if (denied) return denied;

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
    annotations: CREATES_ON_MACHINE,
    description:
      "Save a new brew profile to the machine. This creates something the user will see on the machine's own screen, so before calling it, show them the whole profile you intend to write — name, brew temperature, and every phase's target and stop conditions — and get an explicit yes. Do not upload a profile you invented while giving dial-in advice. It creates and never updates: the machine assigns a fresh id and ignores any id you send, so calling this twice leaves two profiles, and this server deliberately will not retry it for you — if a call fails without a clear answer, call list_profiles to see whether it landed before trying again. The reliable way to build one is to take a profile that already works, change only what you mean to change, and give it a new name; get_profile_info's `definition` field is exactly this shape. Uploading does not load the profile — call select_profile afterwards, again with the user's agreement. Times are in milliseconds and temperatures in degrees Celsius; these are NOT the x10-scaled values shot datapoints use. Refuses unless this server has an authorization server configured, since an unauthenticated server exposed over a tunnel would let anyone reach it.",
    handler: async (input) => {
      const denied = writeToolDisabled("Profile upload");
      if (denied) return denied;

      let created: CreatedProfile;
      try {
        created = await getClient().createProfile(input.profile);
      } catch (error) {
        const failure = describeUploadFailure(error, input.profile.name);
        if (failure === undefined) throw error;
        return failure;
      }

      const machineProfileId = created.id ?? null;
      return {
        structured: { machineProfileId, name: input.profile.name },
        text:
          machineProfileId === null
            ? `Saved '${input.profile.name}' to the machine, but its reply carried no id, so this server cannot tell you which one it is. Call list_profiles to find it — do not upload it again, or there will be two.`
            : `Saved '${input.profile.name}' to the machine as profile id ${machineProfileId}. It is not loaded yet: pass that id to select_profile, with the user's agreement, to brew with it.`,
      };
    },
    inputSchema: z.object({
      profile: ProfileUploadInput.describe(
        "The profile to save. Do not include an id — the machine assigns a fresh one and ignores any id sent, and passing one is rejected here so a copied profile cannot be mistaken for an edit of the original.",
      ),
    }),
    name: "upload_profile",
    outputSchema: ProfileUploadOutput,
    title: "Save a new brew profile",
  }),

  defineTool({
    annotations: DELETES_ON_MACHINE,
    description:
      "Permanently delete a brew profile from the machine. There is no undo and this server cannot restore a deleted profile, so only call this when the user has asked for this specific profile to be deleted, in this conversation, by name. Never delete a profile on your own initiative — not to tidy up, not to remove a duplicate you created, not as a step in some other task. Requires the profile's exact name in confirm_name as well as its id, so the deletion cannot be an off-by-one: read the name from list_profiles and pass it back exactly as reported. Refuses to delete the profile the machine currently has selected, and refuses unless this server has an authorization server configured.",
    handler: async (input) => {
      const denied = writeToolDisabled("Profile deletion");
      if (denied) return denied;

      const { catalog, entry } = await findCatalogEntry(input.profile_id);
      if (!entry) {
        return {
          isError: true,
          text: `No profile matching '${input.profile_id}'. Nothing was deleted. Available ids: ${catalog.entries.map((candidate) => candidate.id).join(", ")}.`,
        };
      }
      if (entry.machineProfileId === null) {
        return {
          isError: true,
          text:
            catalog.source === "machine"
              ? `'${entry.name}' is not on the machine, so there is nothing to delete. Call list_profiles to see what is actually loaded.`
              : `The machine could not be reached, so this server does not know which profile '${entry.name}' is on it and will not guess at an id to delete. ${catalog.note}`,
        };
      }

      // The confirmation is a strict `===` and not another `findCatalogEntry`.
      // That helper is deliberately lenient — it trims, lowercases, and matches
      // id *or* name — so routing the echoed name back through it would let
      // "zer0" confirm "Zer0" and turn the gate into theatre.
      //
      // Compared against the machine's own spelling where there is one, because
      // that is what the user sees on the machine and what `list_profiles`
      // reports for a profile it did not document. For a documented profile the
      // machine's name and the YAML's can differ in case, so both are accepted
      // rather than making the user guess which surface the gate reads.
      const accepted = [entry.machineName, entry.name].filter(
        (candidate): candidate is string => candidate !== null,
      );
      if (!accepted.includes(input.confirm_name)) {
        return {
          isError: true,
          text: `Refusing to delete: confirm_name was '${input.confirm_name}' but profile '${input.profile_id}' is named '${accepted[0]}'. Nothing was deleted. This check exists because profile ids on this machine are sparse and non-contiguous, so an off-by-one deletes a profile nobody asked about. Read the name from list_profiles and pass it back exactly.`,
        };
      }

      // Fail closed. The status read is the only thing standing between this and
      // deleting the profile the machine is brewing with, and `/api/system/status`
      // is deliberately uncached so the answer is always live. If it cannot be
      // read, this server does not know what is selected — and "probably fine"
      // is not a basis for an irreversible delete.
      let selectedProfileId: string | undefined;
      try {
        selectedProfileId = (await getClient().getStatus()).profileId;
      } catch {
        return {
          isError: true,
          text: `Refusing to delete '${entry.name}': the machine did not answer a status check, so this server cannot tell whether that profile is the one currently selected. Nothing was deleted. Try again when the machine is reachable.`,
        };
      }
      // An absent `profileId` is treated differently from an unreadable status,
      // and the asymmetry is deliberate. A failed read is transient — trying
      // again in a minute may well answer — so refusing costs the user nothing
      // permanent. A firmware that simply does not report the field would refuse
      // *forever*, making the tool unusable on that machine rather than safer on
      // it. The field is undocumented, so that is a real possibility and not a
      // hypothetical. What still stands in the way there is the exact-name echo
      // and a permission prompt the host cannot suppress.
      if (
        selectedProfileId !== undefined &&
        selectedProfileId === entry.machineProfileId
      ) {
        return {
          isError: true,
          text: `Refusing to delete '${entry.name}': it is the profile the machine currently has selected. Nothing was deleted. Ask the user to select a different profile first — with select_profile, or on the machine itself — and then delete this one.`,
        };
      }

      try {
        await getClient().deleteProfileFromMachine(entry.machineProfileId);
      } catch (error) {
        const failure = describeDeleteFailure(error, entry.name);
        if (failure === undefined) throw error;
        return failure;
      }

      return {
        text: `Deleted '${entry.name}' (machine profile id ${entry.machineProfileId}) from the machine. This cannot be undone — if it was a mistake, the profile has to be rebuilt by hand or re-uploaded from a definition saved earlier in this conversation.`,
      };
    },
    inputSchema: z.object({
      confirm_name: z
        .string()
        .min(1)
        .describe(
          "The profile's exact name, copied from list_profiles. Must match, or the deletion is refused. This is a confirmation, not a lookup — do not guess it, and do not derive it from profile_id.",
        ),
      profile_id: z
        .string()
        .min(1)
        .describe(
          'Id of the profile to delete, as listed by list_profiles — either its documented id ("zer0") or its machineProfileId ("15").',
        ),
    }),
    meta: {
      /**
       * The one place in this server that sets it, and the reason AGENTS.md's
       * blanket prohibition became a named set rather than staying a rule.
       *
       * That prohibition's own justification was *"Nothing here warrants it —
       * every tool reads."* This one does not. The flag's properties — it falls
       * through to the permission prompt in every mode, the host offers no
       * "don't ask again", and an existing allow rule does not skip it — are
       * costs for a read tool and precisely the behaviour wanted for a delete
       * that cannot be undone.
       */
      "anthropic/requiresUserInteraction": true,
    },
    name: "delete_profile",
    title: "Delete a brew profile",
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
