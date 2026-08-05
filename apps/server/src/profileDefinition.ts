import { z } from "zod";
import {
  getClient,
  MACHINE_URL,
  type MachineProfileDefinition,
} from "./client";
import { describeUpstreamError, UpstreamHttpError } from "./errors";
import { type CatalogEntry, type ProfileCatalog } from "./profileCatalog";
import {
  GLOBAL_STOP_CONDITION_KEYS,
  PHASE_STOP_CONDITION_KEYS,
  PHASE_TYPES,
  TRANSITION_CURVES,
} from "./profileShape";

/**
 * The machine's own definition of a profile, and how it is shown.
 *
 * ## The definition is echoed, not translated
 *
 * `definition` carries the machine's export **verbatim** — the same key names,
 * the same units, milliseconds and all, and upstream's `switchToManuaFlowCtrl`
 * misspelling preserved. That is deliberate and it is the load-bearing decision
 * in this module.
 *
 * The tempting alternative is to normalize on the way out: `time` → `timeSec`,
 * `waterTemperature` → `waterTemperatureC`, the typo corrected. It reads better
 * and it is wrong, because the reference says the `POST /api/profile` body is
 * *"Same shape as the `GET /api/profile/*` response"* (`docs/upstream/rest-api.md`
 * L85). **This field is the upload tool's input.** "Take the profile that works,
 * soften the preinfusion, upload it" is the actual workflow, and it is the only
 * place a model can get a profile that works. Two dialects means a model copies
 * `rampSec: 5` back into `time`, uploads a five-millisecond ramp, and the
 * machine accepts it silently — the reference fills malformed fields with
 * zero-value defaults rather than rejecting them.
 *
 * So all the humanising — seconds, "3 bar", phase numbering — happens in
 * `formatProfileDefinition`, i.e. in the prose a person reads, which is what
 * `get_profile_info`'s text output is for.
 *
 * The output schema is loose for the same reason the client boundary is: a
 * strict `z.object` emits `additionalProperties: false` and would drop a phase
 * field a future firmware adds, so a model that edited and re-uploaded such a
 * definition would silently delete it from the user's machine.
 */

const TARGET_CURVES = TRANSITION_CURVES.join('", "');

export const ProfileDefinitionOutput = z.looseObject({
  globalStopConditions: z
    .looseObject({
      switchToManuaFlowCtrl: z.boolean().optional(),
      switchToManualPressureCtrl: z.boolean().optional(),
      time: z.number().optional(),
      waterPumped: z.number().optional(),
      weight: z.number().optional(),
    })
    .nullable()
    .describe(
      `What ends the shot regardless of which phase is running: ${GLOBAL_STOP_CONDITION_KEYS.join(", ")}. \`time\` is MILLISECONDS, \`weight\` grams. Null when the profile carries none. Upstream misspells the flow-control flag as switchToManuaFlowCtrl; it is passed through unchanged so a profile can be uploaded back.`,
    ),
  name: z.string().nullable().describe("Profile name as stored on the machine"),
  phases: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        restriction: z.number().optional(),
        skip: z.boolean().optional(),
        stopConditions: z.record(z.string(), z.number()).optional(),
        target: z
          .looseObject({
            curve: z.string().optional(),
            end: z.number().optional(),
            start: z.number().optional(),
            time: z.number().optional(),
          })
          .optional(),
        type: z.string().optional(),
        waterTemperature: z.number().optional(),
      }),
    )
    .describe(
      `Phases in the order the machine runs them. Each has a \`type\` ("${PHASE_TYPES.join('", "')}"), a \`target\` ramp whose \`end\` is bar for a PRESSURE phase and ml/s for a FLOW phase, \`time\` in MILLISECONDS, and a \`curve\` from "${TARGET_CURVES}". \`stopConditions\` are drawn from ${PHASE_STOP_CONDITION_KEYS.join(", ")}, and their \`time\` is milliseconds too. This is the machine's own wire format, so it can be edited and passed straight back to upload_profile.`,
    ),
  recipe: z
    .looseObject({
      coffeeIn: z.number().optional(),
      coffeeOut: z.number().optional(),
      ratio: z.number().optional(),
    })
    .nullable()
    .describe(
      "The dose and yield the profile was written around, in grams; null when it carries none",
    ),
  waterTemperature: z
    .number()
    .nullable()
    .describe(
      "Brew temperature the profile asks for, in real degrees Celsius — NOT the scaled-by-10 form the shot time-series uses. 93 means 93°C.",
    ),
});

export type ProfileDefinition = z.input<typeof ProfileDefinitionOutput>;

/**
 * Guarantee the five documented top-level fields exist so a caller reading
 * `definition.recipe` gets an explicit `null` rather than `undefined`, and
 * `phases` is always iterable. Everything else — including every unknown key at
 * every level — passes straight through.
 */
export function shapeDefinition(
  raw: MachineProfileDefinition,
): ProfileDefinition {
  return {
    ...raw,
    globalStopConditions: raw.globalStopConditions ?? null,
    name: raw.name ?? null,
    phases: raw.phases ?? [],
    recipe: raw.recipe ?? null,
    waterTemperature: raw.waterTemperature ?? null,
  };
}

/**
 * Degrade, or rethrow.
 *
 * An HTTP status, a body this server cannot parse, or a machine that vanished
 * mid-call are all *this field's* problem: the profile's documentation is still
 * a good answer, and the reason travels into the text with it. Anything
 * `describeUpstreamError` does not recognise is a bug in this server and must
 * not be reported as "the machine's definition is unavailable".
 *
 * The 404 branch comes first and deliberately never reaches
 * `describeUpstreamError`'s bare-404 text, which asserts the machine is
 * "running a firmware version that does not expose it" — true half the time
 * here, and a lie the other half, because the machine answers 404 identically
 * for a profile deleted since the list was read. That ambiguity is why this
 * lives here rather than as another branch in `errors.ts`.
 */
export function definitionFailureNote(
  error: unknown,
  machineProfileId: string,
): string {
  if (error instanceof UpstreamHttpError && error.status === 404) {
    return `The machine did not serve a definition for profile id '${machineProfileId}' (HTTP 404). Either this firmware predates the per-profile export endpoint, or the profile was removed since the list was read — the machine does not distinguish the two. Everything above still applies; call list_profiles to re-read what it currently holds.`;
  }
  const reason = describeUpstreamError(error, MACHINE_URL);
  if (reason === null) throw error;
  return `The machine's own definition of this profile could not be read, so only what this server documents is shown. ${reason}`;
}

export interface ProfileDefinitionResult {
  definition: ProfileDefinition | null;
  note: string;
}

/**
 * Fetch always goes through `machineProfileId`, never `entry.id`: the
 * documented id ("zer0") means nothing to the machine and would 404 every time.
 *
 * The three no-request cases matter as much as the fetch. Asking the machine
 * for a profile it has already said it does not hold — or that this server
 * never managed to ask about — is a round trip to a device that serves one
 * request at a time, spent to learn something already known.
 */
export async function loadProfileDefinition(
  entry: CatalogEntry,
  catalog: ProfileCatalog,
): Promise<ProfileDefinitionResult> {
  if (entry.onMachine === null) {
    return {
      definition: null,
      note: `The machine could not be reached, so this server could not read its own definition of this profile. ${catalog.note}`,
    };
  }
  if (entry.onMachine === false) {
    return {
      definition: null,
      note: "This profile is documented on this server but is not on the machine, so there is no machine definition to read.",
    };
  }
  if (entry.machineProfileId === null) {
    return {
      definition: null,
      note: "The machine listed this profile but gave no id for it, so its definition cannot be fetched.",
    };
  }

  try {
    const raw = await getClient().getProfileDefinition(entry.machineProfileId);
    return {
      definition: shapeDefinition(raw),
      note: "Read from the machine's own profile export. Times are in milliseconds and temperatures in real degrees Celsius — this is the machine's wire format, and upload_profile takes it back unchanged.",
    };
  } catch (error) {
    return {
      definition: null,
      note: definitionFailureNote(error, entry.machineProfileId),
    };
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Stop conditions rendered as phrases rather than as a key dump.
 *
 * Table-driven with a `key: value` fallback, so a condition a future firmware
 * adds is *printed* rather than dropped — the same tolerance the schema keeps,
 * carried into the text where a person will actually notice it.
 */
const STOP_CONDITION_PHRASES: Record<string, (value: number) => string> = {
  flowAbove: (v) => `flow above ${v} ml/s`,
  flowBelow: (v) => `flow below ${v} ml/s`,
  pressureAbove: (v) => `pressure above ${v} bar`,
  pressureBelow: (v) => `pressure below ${v} bar`,
  time: (v) => `${seconds(v)} elapsed`,
  waterPumpedInPhase: (v) => `${v} ml pumped in this phase`,
  weight: (v) => `${v} g in the cup`,
};

function describeStopConditions(
  conditions: Record<string, number> | undefined,
): string | null {
  const parts = Object.entries(conditions ?? {}).map(([key, value]) =>
    (STOP_CONDITION_PHRASES[key] ?? (() => `${key}: ${value}`))(value),
  );
  return parts.length === 0 ? null : parts.join(", or ");
}

/** Bar for a pressure ramp, ml/s for a flow one, and nothing for a phase whose type this server does not recognise. */
function targetUnit(type: string | undefined): string {
  if (type === "PRESSURE") return " bar";
  if (type === "FLOW") return " ml/s";
  return "";
}

export function formatProfileDefinition(
  result: ProfileDefinitionResult,
): string[] {
  const lines = ["## Machine definition", "", result.note, ""];
  const definition = result.definition;
  if (!definition) return lines;

  if (definition.waterTemperature !== null) {
    lines.push(`**Brew temperature:** ${definition.waterTemperature}°C`);
  }
  const recipe = definition.recipe;
  if (recipe) {
    const parts = [
      recipe.coffeeIn === undefined ? null : `${recipe.coffeeIn} g in`,
      recipe.coffeeOut === undefined ? null : `${recipe.coffeeOut} g out`,
      recipe.ratio === undefined ? null : `ratio ${recipe.ratio}`,
    ].filter((part) => part !== null);
    if (parts.length > 0) lines.push(`**Recipe:** ${parts.join(" → ")}`);
  }
  const global = definition.globalStopConditions;
  if (global) {
    const parts = [
      global.time === undefined ? null : `${seconds(global.time)} elapsed`,
      global.weight === undefined ? null : `${global.weight} g in the cup`,
      global.waterPumped === undefined
        ? null
        : `${global.waterPumped} ml pumped`,
    ].filter((part) => part !== null);
    if (parts.length > 0) lines.push(`**Stops when:** ${parts.join(", or ")}`);
    if (global.switchToManuaFlowCtrl === true) {
      lines.push("**Hands flow control back to you when the phases end.**");
    }
    if (global.switchToManualPressureCtrl === true) {
      lines.push("**Hands pressure control back to you when the phases end.**");
    }
  }

  lines.push("", "### Phases", "");
  if (definition.phases.length === 0) {
    lines.push("The machine reported no phases for this profile.");
    return lines;
  }

  // A phase is named only when someone set one in the machine's UI or uploaded
  // it with the profile. Profiles built on the machine's own screen carry no
  // `name` on any phase, so a fallback label prints on nearly every phase of
  // nearly every profile — marking the rule rather than the exception. Omit it
  // instead and let the phase lead with its type.
  definition.phases.forEach((phase, index) => {
    const label = [
      phase.name === undefined ? null : `**${phase.name}**`,
      phase.type ?? null,
    ].filter((part) => part !== null);

    const target = phase.target;
    let ramp: string | null = null;
    if (target?.end !== undefined) {
      const unit = targetUnit(phase.type);
      const over =
        target.time === undefined ? "" : ` over ${seconds(target.time)}`;
      const curve = target.curve === undefined ? "" : ` (${target.curve})`;
      const from =
        target.start === undefined ? "" : `from ${target.start}${unit} `;
      ramp = `ramp ${from}to ${target.end}${unit}${over}${curve}`;
    }

    const summary = [label.join(" — "), ramp]
      .filter((part) => part !== null && part !== "")
      .join(", ");
    const skipped = phase.skip === true ? " — SKIPPED, will not run" : "";
    lines.push(`${index + 1}.${summary === "" ? "" : ` ${summary}`}${skipped}`);

    const stops = describeStopConditions(phase.stopConditions);
    if (stops !== null) lines.push(`   Ends at: ${stops}`);
    if (phase.waterTemperature !== undefined) {
      lines.push(`   Brew temperature: ${phase.waterTemperature}°C`);
    }
    if (phase.restriction !== undefined && phase.restriction !== 0) {
      lines.push(`   Restriction: ${phase.restriction}`);
    }
  });

  // Once, not per phase. A real lever profile runs to nineteen phases and
  // sixteen of them set a restriction; the caveat is the same sentence every
  // time, and repeating it costs more context than the values it annotates.
  if (
    definition.phases.some(
      (phase) => phase.restriction !== undefined && phase.restriction !== 0,
    )
  ) {
    lines.push(
      "",
      "Restriction values above are the machine's own; its documentation does not state this field's unit.",
    );
  }

  return lines;
}
