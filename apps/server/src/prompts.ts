import {
  type Prompt,
  type PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatFieldIssues } from "./errors";
import { DIAL_IN_PROMPT_NAME, renderDialInGuidance } from "./guidance";
import { loadPrompts } from "./loader";

type ArgsSchema = z.ZodObject;

/** A prompt as the renderer sees it, with its render function's argument type erased. */
export interface PromptDefinition {
  argsSchema: ArgsSchema;
  /**
   * Resolved per request rather than stored as a string, because the dial-in
   * prompt's description comes from `prompts.yaml` and may be replaced by a
   * user's `prompts.local.yaml`. ListPrompts used to advertise a hardcoded
   * literal, so an override the loader honoured everywhere else was invisible
   * on the one surface a host actually shows the user.
   */
  describe: () => string;
  name: string;
  render: (args: unknown) => string;
  title: string;
}

function definePrompt<A extends ArgsSchema>(spec: {
  argsSchema: A;
  describe: () => string;
  name: string;
  render: (args: z.output<A>) => string;
  title: string;
}): PromptDefinition {
  return {
    argsSchema: spec.argsSchema,
    describe: spec.describe,
    name: spec.name,
    render: (args) => spec.render(args as z.output<A>),
    title: spec.title,
  };
}

/**
 * A required prompt argument.
 *
 * Prompt arguments cross the wire as strings — that is all the protocol carries
 * — so every schema here is a string schema and the enforcement worth having is
 * that a required one arrives present and non-blank. Both zod defaults for that
 * case ("expected string, received undefined" and "Too small: expected string
 * to have >=1 characters") describe the type system rather than what the user
 * has to do, so both are replaced with one actionable sentence.
 */
function requiredArg(description: string) {
  const message = "missing — this prompt cannot run without a value for it";
  return z
    .string({ error: message })
    .trim()
    .min(1, message)
    .describe(description);
}

/** An optional prompt argument. Blank and absent are the same thing to a host's form field. */
function optionalArg(description: string) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .describe(description);
}

/**
 * One `- Label: value` line of a prompt's preamble.
 *
 * An argument the user left blank renders its fallback instruction rather than
 * disappearing: the model is told what to do about the gap ("use the profile's
 * recommended dose") instead of being left to invent a number the tools could
 * have told it.
 */
function detail(label: string, value: string | undefined, whenBlank: string) {
  return `- ${label}: ${value ?? whenBlank}`;
}

/**
 * Turn a prompt's zod schema into the `arguments` array advertised over the wire.
 *
 * Generated through the same `z.toJSONSchema` path the tool schemas use, so the
 * advertised name, description, and required flag come from the schema the
 * renderer enforces — there is no second hand-maintained list to drift.
 */
function promptArguments(schema: ArgsSchema): PromptArgument[] {
  // An object schema always carries `properties`, even when empty; `required` is
  // omitted entirely when every argument is optional.
  const { properties, required } = z.toJSONSchema(schema, {
    io: "input",
  }) as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  const requiredNames = new Set(required ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    description: property.description,
    name,
    required: requiredNames.has(name),
  }));
}

/**
 * The adjustment policy the dial-in plans shipped without.
 *
 * `dial_in_new_bag` and `diagnose_last_shot` both told the model to change one
 * variable and re-pull, and neither said how far to move it, which way after a
 * reversal, or when to stop — so the loop they describe has no termination
 * condition. A model will suggest "a bit finer" indefinitely, oscillate around
 * the target because nothing tells it to shrink the step after an overshoot,
 * and never say "this is dialled in".
 *
 * **The round history is the conversation, so this is text rather than state.**
 * The obvious implementation of a convergence loop is a session object holding
 * the rounds, and there is nowhere here to put one — no database, no persisted
 * user state, and the session TTL evicts anything in memory. None of that is
 * needed: the model already has every shot in context. What was missing is the
 * policy for reading them, which costs one shared constant and re-keys no
 * permission grant.
 *
 * Shared rather than written into each plan twice, because two copies of a
 * numeric rule drift. A `const` rather than a builder function because there is
 * nothing to parameterise — and note that `apps/server`'s `functions: 100`
 * coverage gate constrains anything added here: `prompts.test.ts` renders every
 * prompt, so a helper *some* render reaches is covered, but one no render path
 * reaches fails the build outright.
 *
 * The numbers are starting guidance, not the server's opinion: band, dose and
 * grinder resolution are equipment-specific, which is what `user_context` in
 * `prompts.yaml` already exists to override.
 */
const ADJUSTMENT_POLICY = [
  "",
  "## How far to move it, and when to stop",
  "",
  "These are defaults. Anything my own setup notes say, via `get_dial_in_guidance`, replaces them.",
  "",
  "- **Target window.** Use the `targetTime` window `list_profiles` or `get_profile_info` reports for this profile, and treat anything inside it as on target — measure error from the nearest edge, not from the middle. The windows are wide on purpose and they differ a lot by profile. `globalStopConditions.time` in a profile's definition is a hard cutoff, not a target; do not read it as one.",
  "- **When the profile reports no target time**, aim for 25-32 seconds and treat 27.5-29.5 as on target — but only for an espresso profile. Ask me what the profile is for before assuming: a turbo profile is much shorter and a filter profile runs for minutes, and dialling either toward 30 seconds is the wrong loop entirely.",
  '- **Hold.** Inside that dead zone, say so and change nothing. "This is dialled in, stop adjusting" is a valid answer, and I would rather hear it than be given another change to make.',
  "- **First step.** Size it from how far the first shot missed: about one grinder step per 6 seconds of error, never less than half a step, never more than two. Say it in my grinder's units, not in seconds.",
  "- **Halve on a reversal.** If the change you are about to suggest is the opposite direction to the last one, halve the step. If it is the same direction, keep it. Never grow it.",
  "- **Stop** as soon as any of these is true, and name the one that fired: two shots in a row landed in the dead zone; the next step would be finer than my grinder can actually set; or we have made six adjustments on this coffee. Six is a safety valve, not a target.",
  "",
  "Take the round history from this conversation — the shots already pulled are the record. Do not ask me to repeat them.",
  "",
  "**A shot that collapsed carries no grind signal.** When `get_shot_data` lists, under one of the phases, an event whose text begins \"pressure fell\", the puck gave way instead of resisting, so that shot's time says nothing about the grind. Do not read a direction from it, and do not let it seed or halve the step — treat it as a round that did not happen, fix the cause (puck prep, distribution, basket, dose) and re-pull. The reverse does not hold: no event is not proof the puck held. It means either that nothing crossed the detector's threshold, or that the shot's profile named no phases at all — in which case the breakdown says so and no event could be reported either way.",
  "",
  '**A shot the sensors misreported carries no signal either.** The guidance\'s "When Not to Trust the Data" section says how to recognise one — peak pressure far out of family with other shots on the same profile while the scale describes a normal extraction is the signature. Treat it as a round that did not happen: no direction, no step, and what needs fixing before the next pull is the sensor path, not the puck or the grind.',
  "",
  "Brew ratio and extraction yield are outcome checks, not direction signals: pick the direction from extraction time, then confirm the ratio landed where the profile intended. If I give you a refractometer reading, extraction yield is (yield in grams x TDS%) / dose in grams, and the SCA Golden Cup band is 18-22%. The machine cannot measure TDS, so ask me for it rather than estimating it.",
];

/**
 * The workflow prompts are defined here rather than in `prompts.yaml` on
 * purpose. What they contain is a plan naming *this server's own tools*, so a
 * local override could point a step at a tool that does not exist; the part a
 * user genuinely wants to tune — their grinder, basket, and machine mods — is
 * already `user_context` in the YAML, and every plan below picks it up by
 * calling `get_dial_in_guidance` in step 1 instead of restating it.
 */
export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  definePrompt({
    argsSchema: z.object({}),
    describe: () =>
      loadPrompts()[DIAL_IN_PROMPT_NAME]?.description ??
      "Expert guidance for dialling in espresso on a Gaggiuino.",
    name: DIAL_IN_PROMPT_NAME,
    render: () => {
      const guidance = renderDialInGuidance();
      // Unlike a tool, a prompt has no isError channel: a host asking for a
      // prompt this server advertised and getting nothing back needs the
      // JSON-RPC error, not an empty message.
      if (guidance === undefined) {
        throw new Error(`Missing prompt: ${DIAL_IN_PROMPT_NAME}`);
      }
      return guidance;
    },
    title: "Espresso shot analyst",
  }),

  definePrompt({
    argsSchema: z.object({
      bean: requiredArg(
        'The coffee: roaster, origin, and name if you have them, e.g. "Coffee Supreme, Ethiopia Guji".',
      ),
      dose_g: optionalArg(
        'Dose in grams, e.g. "18". Leave blank to use the profile\'s recommended dose.',
      ),
      roast_level: optionalArg(
        "Roast level if you know it: light, medium-light, medium, medium-dark, or dark.",
      ),
      target: optionalArg(
        'What you want in the cup, e.g. "bright and tea-like" or "syrupy, for milk".',
      ),
    }),
    describe: () =>
      "Dial in a bag you have not pulled before: pick a profile for the roast, set a starting point, then adjust one variable per shot.",
    name: "dial_in_new_bag",
    render: (args) =>
      [
        "I am starting a new bag of coffee and want to dial it in on my Gaggiuino.",
        "",
        `- Bean: ${args.bean}`,
        detail(
          "Roast level",
          args.roast_level,
          "not stated — infer it from the bean if you can, otherwise ask me before choosing a profile",
        ),
        detail(
          "Dose",
          args.dose_g && `${args.dose_g} g`,
          "not stated — use the recommended dose for the profile you pick",
        ),
        detail(
          "What I want in the cup",
          args.target,
          "not stated — assume a balanced espresso",
        ),
        "",
        "Work through this in order:",
        "",
        "1. Call `get_dial_in_guidance` and follow it for the rest of this conversation. It carries the roast-level-to-profile mapping and my equipment.",
        "2. Call `get_status` to check the machine is up to temperature and has water.",
        "3. Call `list_profiles` and choose the profile whose type suits this roast. Recommend only profiles the machine actually holds, and say in one sentence why that one.",
        "4. If it is not the profile already loaded, ask me before calling `select_profile` — that one changes the machine.",
        "5. Give me a starting point: grind direction relative to my usual setting, dose, target yield, and target time.",
        "6. After I pull the shot, call `get_latest_shot_id` for its id and headline numbers, then `get_shot_data` with that id — the phase breakdown is the only place a pressure-collapse event appears, and the rule below depends on seeing it. Change ONE variable before the next shot and tell me which and why.",
        "",
        "Do not guess at anything the tools can tell you.",
        ...ADJUSTMENT_POLICY,
      ].join("\n"),
    title: "Dial in a new bag",
  }),

  definePrompt({
    argsSchema: z.object({
      changed: optionalArg(
        'Anything you changed since the previous shot, e.g. "ground two steps finer".',
      ),
      taste: requiredArg(
        'What was wrong with it, in your words — e.g. "sour and thin", "harsh and drying", "gushed after 10 seconds".',
      ),
    }),
    describe: () =>
      "Diagnose the shot you just pulled from its recorded data and what it tasted like, and get one adjustment to make next.",
    name: "diagnose_last_shot",
    render: (args) =>
      [
        "The shot I just pulled was not right. Help me work out what to change.",
        "",
        `- What I tasted: ${args.taste}`,
        detail(
          "Changed since the last shot",
          args.changed,
          "nothing I can think of",
        ),
        "",
        "Work through this in order:",
        "",
        "1. Call `get_dial_in_guidance` and diagnose against it, not against generic espresso advice.",
        "2. Call `get_latest_shot_id` for the shot's id and headline numbers.",
        "3. Call `get_shot_data` with that id for the phase-by-phase breakdown.",
        "4. Call `get_profile_info` for the profile the shot ran, so you read the numbers against that profile's targets rather than a generic ideal.",
        "5. Only if the shape of the curve matters — channeling spikes, pressure oscillation, a flow surge — call `view_shot_graph`. Otherwise stay in text.",
        "6. Only if the numbers point at the machine rather than the coffee — flow that will not reach the profile's targets, or a brew temperature that will not hold, at a grind that used to work — call `get_maintenance_status`. Scale build-up reads as flow and temperature instability, not as a grind problem.",
        "7. If I have pulled several shots on this coffee, call `list_recent_shots` and say whether this one is a trend or a one-off.",
        "",
        "Then tell me: the most likely cause, the ONE variable to change next, and which direction to move it. If the data contradicts what I tasted, say so.",
        ...ADJUSTMENT_POLICY,
      ].join("\n"),
    title: "Diagnose the last shot",
  }),

  definePrompt({
    argsSchema: z.object({
      drink: optionalArg(
        'What you are making, e.g. "straight espresso", "flat white", "filter-style".',
      ),
      notes: optionalArg(
        'Anything else worth knowing, e.g. "channels badly on lever profiles", "two weeks off roast", "21g basket".',
      ),
      roast_level: requiredArg(
        "Roast level of the coffee: light, medium-light, medium, medium-dark, or dark.",
      ),
    }),
    describe: () =>
      "Choose which of the machine's brew profiles suits a coffee, with the runner-up and the reason for each.",
    name: "choose_profile",
    render: (args) =>
      [
        "Help me pick a brew profile on my Gaggiuino for this coffee.",
        "",
        `- Roast level: ${args.roast_level}`,
        detail("Drink", args.drink, "not stated — assume straight espresso"),
        detail("Notes", args.notes, "none"),
        "",
        "Work through this in order:",
        "",
        "1. Call `get_dial_in_guidance` for the roast-level-to-profile-type mapping and the profile characteristics.",
        "2. Call `list_profiles`. Recommend only profiles with `onMachine: true` — if the best match on paper is documented but not loaded on the machine, say so rather than recommending something I cannot select.",
        "3. Call `get_profile_info` for your top two candidates and compare their target ratio and time.",
        "4. Recommend one with a one-sentence reason tied to the roast level, and name the runner-up and when I would prefer it.",
        "5. Ask me before calling `select_profile`.",
      ].join("\n"),
    title: "Choose a brew profile",
  }),
];

export const PROMPTS_BY_NAME = new Map(
  PROMPT_DEFINITIONS.map((prompt) => [prompt.name, prompt]),
);

/**
 * The advertised prompt list.
 *
 * A function rather than a module constant like `TOOLS`, because a description
 * can come from `prompts.yaml` — building the list per request keeps a local
 * override authoritative and keeps file reads out of module load.
 */
export function advertisedPrompts(): Prompt[] {
  return PROMPT_DEFINITIONS.map((prompt) => {
    const advertised: Prompt = {
      description: prompt.describe(),
      name: prompt.name,
      title: prompt.title,
    };
    const args = promptArguments(prompt.argsSchema);
    // An empty `arguments` array and no `arguments` key mean the same thing to a
    // host; the absent key is the honest way to say "this prompt takes none".
    if (args.length > 0) advertised.arguments = args;
    return advertised;
  });
}

/**
 * The one place a prompt is rendered.
 *
 * Mirrors `handleToolCall`: arguments are parsed against the same schema the
 * advertised `arguments` array was generated from, so a render function receives
 * typed values and never re-checks presence. Prompts have no `isError` channel,
 * so a bad request throws — which is what a host needs in order to put the
 * missing field back in front of the user.
 */
export function renderPrompt(
  name: string,
  args: Record<string, string> | undefined,
): string {
  const prompt = PROMPTS_BY_NAME.get(name);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const parsed = prompt.argsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid arguments for prompt ${name}:\n${formatFieldIssues(parsed.error)}\nSupply the listed arguments and request the prompt again.`,
    );
  }
  return prompt.render(parsed.data);
}
