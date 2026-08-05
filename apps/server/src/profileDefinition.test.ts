import { describe, expect, it } from "vitest";
import {
  mockProfileDefinition,
  mockProfileDefinitionFull,
  mockSparseProfileDefinition,
} from "./__fixtures__/api-responses";
import { type MachineProfileDefinition } from "./client";
import {
  MalformedUpstreamError,
  UpstreamHttpError,
  UpstreamUnreachableError,
} from "./errors";
import {
  definitionFailureNote,
  formatProfileDefinition,
  loadProfileDefinition,
  ProfileDefinitionOutput,
  shapeDefinition,
} from "./profileDefinition";

/**
 * Fixtures are wire payloads, not typed values — TypeScript widens the two
 * differently-shaped phases in `mockProfileDefinitionFull` into a union the
 * boundary schema's `Record<string, number>` will not accept. Going through the
 * boundary type is what the client does with real bytes.
 */
function wire(raw: unknown): MachineProfileDefinition {
  return raw as MachineProfileDefinition;
}

describe("shapeDefinition", () => {
  it("echoes the machine's wire format without translating it", () => {
    // The whole point: this value is upload_profile's input, so a normalized
    // dialect here would be a profile a model cannot round-trip.
    const shaped = shapeDefinition(wire(mockProfileDefinition));

    expect(shaped.waterTemperature).toBe(93);
    expect(shaped.phases[0]?.target?.time).toBe(5000);
    expect(shaped.phases[0]?.stopConditions?.time).toBe(10000);
    expect(shaped.globalStopConditions?.time).toBe(40000);
    expect(shaped.recipe?.coffeeIn).toBe(18);
  });

  it("fills the documented fields with null rather than leaving them absent", () => {
    const shaped = shapeDefinition(wire(mockSparseProfileDefinition));

    expect(shaped).toMatchObject({
      globalStopConditions: null,
      name: "Bare",
      phases: [],
      recipe: null,
      waterTemperature: null,
    });
  });

  it("survives the output schema's parse whatever the machine sent", () => {
    // `structured` is `.parse()`d by the dispatcher, so a definition that could
    // fail here would take the whole tool call down.
    expect(() =>
      ProfileDefinitionOutput.parse(
        shapeDefinition(wire(mockSparseProfileDefinition)),
      ),
    ).not.toThrow();
    expect(() =>
      ProfileDefinitionOutput.parse(
        shapeDefinition(wire(mockProfileDefinitionFull)),
      ),
    ).not.toThrow();
  });

  it("preserves a stop condition this server has never heard of", () => {
    // A strict output schema would drop it, and a model that edited and
    // re-uploaded the definition would silently delete it from the machine.
    const parsed = ProfileDefinitionOutput.parse(
      shapeDefinition(wire(mockProfileDefinitionFull)),
    );
    const phase = parsed.phases[1] as {
      stopConditions: Record<string, number>;
    };

    expect(phase.stopConditions.someFutureCondition).toBe(7);
  });

  it("keeps upstream's own misspelling so the profile can be uploaded back", () => {
    const parsed = ProfileDefinitionOutput.parse(
      shapeDefinition(wire(mockProfileDefinitionFull)),
    );
    expect(parsed.globalStopConditions?.switchToManuaFlowCtrl).toBe(true);
  });

  it("carries a corrected spelling through as well, without rewriting either", () => {
    const parsed = ProfileDefinitionOutput.parse(
      shapeDefinition({
        globalStopConditions: { switchToManualFlowCtrl: true },
        name: "Fixed firmware",
      }),
    );
    expect(
      (parsed.globalStopConditions as Record<string, unknown>)
        .switchToManualFlowCtrl,
    ).toBe(true);
  });
});

describe("definitionFailureNote", () => {
  it("names both causes of a 404 rather than blaming the firmware", () => {
    const note = definitionFailureNote(
      new UpstreamHttpError(404, "Not Found", "/api/profile/15"),
      "15",
    );

    expect(note).toContain("predates");
    expect(note).toContain("removed since");
    // errors.ts's bare-404 text asserts one of the two as fact.
    expect(note).not.toContain("firmware version that does not expose it");
  });

  it("reports a machine fault as a machine fault", () => {
    const note = definitionFailureNote(
      new UpstreamHttpError(503, "Service Unavailable", "/api/profile/15"),
      "15",
    );
    expect(note).toContain("HTTP 503");
  });

  it("reports an unreachable machine as unreachable", () => {
    const note = definitionFailureNote(
      new UpstreamUnreachableError(3, "timed out"),
      "15",
    );
    expect(note).toContain("may be powered off");
  });

  it("reports a body it could not parse", () => {
    const note = definitionFailureNote(
      new MalformedUpstreamError("/api/profile/15", "phases: expected array"),
      "15",
    );
    expect(note).toContain("could not understand");
  });

  it("rethrows anything that is not an upstream failure", () => {
    // A bug in this server must not be reported as "the machine's definition
    // is unavailable".
    expect(() => definitionFailureNote(new Error("boom"), "15")).toThrow(
      "boom",
    );
  });
});

describe("loadProfileDefinition", () => {
  const catalog = {
    entries: [],
    note: "The machine could not be reached: it may be powered off.",
    source: "documentation" as const,
  };
  const entry = {
    basketNotes: null,
    description: null,
    documented: false,
    id: "zer0",
    machineProfileId: "15",
    name: "Zer0",
    onMachine: true as boolean | null,
    recommendedDose: null,
    roastLevels: [],
    targetRatio: null,
    targetTime: null,
    type: null,
  };

  // Each of these must reach the machine zero times. Asking it for a profile it
  // has already said it does not hold is a round trip to a device that serves
  // one request at a time, spent to learn something already known.
  it("carries the catalog's own reason when the machine was never reached", async () => {
    const result = await loadProfileDefinition(
      { ...entry, onMachine: null },
      catalog,
    );

    expect(result.definition).toBeNull();
    expect(result.note).toContain("could not be reached");
    expect(result.note).toContain("may be powered off");
  });

  it("says so when the profile is documented but not loaded", async () => {
    const result = await loadProfileDefinition(
      { ...entry, machineProfileId: null, onMachine: false },
      catalog,
    );

    expect(result.definition).toBeNull();
    expect(result.note).toContain("is not on the machine");
  });

  it("says so when the machine listed a profile with no id", async () => {
    const result = await loadProfileDefinition(
      { ...entry, machineProfileId: null },
      catalog,
    );

    expect(result.definition).toBeNull();
    expect(result.note).toContain("gave no id");
  });
});

describe("formatProfileDefinition", () => {
  function render(definition: unknown, note = "Read from the machine.") {
    return formatProfileDefinition({
      definition: definition as never,
      note,
    }).join("\n");
  }

  it("humanises milliseconds into seconds in the prose only", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinition)));

    expect(text).toContain("over 5.0s");
    expect(text).toContain("10.0s elapsed");
    expect(text).toContain("40.0s elapsed");
    expect(text).not.toContain("5000");
  });

  it("labels a pressure ramp in bar and a flow ramp in ml/s", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinitionFull)));

    expect(text).toContain("to 3 bar");
    expect(text).toContain("to 2 ml/s");
  });

  it("marks a phase that will not run", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinitionFull)));
    expect(text).toContain("SKIPPED, will not run");
  });

  it("prints a stop condition it does not recognise rather than dropping it", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinitionFull)));
    expect(text).toContain("someFutureCondition: 7");
  });

  it("reports the per-phase temperature and the undocumented restriction unit", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinitionFull)));

    expect(text).toContain("Brew temperature: 91°C");
    expect(text).toContain("does not state this field's unit");
  });

  it("says when the profile hands control back at the end", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinitionFull)));
    expect(text).toContain("Hands flow control back to you");
  });

  it("renders the recipe and brew temperature", () => {
    const text = render(shapeDefinition(wire(mockProfileDefinition)));

    expect(text).toContain("**Brew temperature:** 93°C");
    expect(text).toContain("18 g in → 36 g out → ratio 2");
  });

  it("is just the heading and the reason when there is no definition", () => {
    const text = render(null, "The machine could not be reached.");

    expect(text).toContain("## Machine definition");
    expect(text).toContain("The machine could not be reached.");
    expect(text).not.toContain("### Phases");
  });

  it("says so when the machine reported a profile with no phases", () => {
    const text = render(shapeDefinition(wire(mockSparseProfileDefinition)));
    expect(text).toContain("no phases for this profile");
  });

  it("phrases every stop condition the machine documents", () => {
    const text = render(
      shapeDefinition(
        wire({
          name: "Everything",
          phases: [
            {
              stopConditions: {
                flowAbove: 3,
                flowBelow: 1,
                pressureAbove: 4,
                pressureBelow: 2,
                time: 10000,
                waterPumpedInPhase: 40,
                weight: 30,
              },
              type: "FLOW",
            },
          ],
        }),
      ),
    );

    expect(text).toContain("flow above 3 ml/s");
    expect(text).toContain("flow below 1 ml/s");
    expect(text).toContain("pressure above 4 bar");
    expect(text).toContain("pressure below 2 bar");
    expect(text).toContain("10.0s elapsed");
    expect(text).toContain("40 ml pumped in this phase");
    expect(text).toContain("30 g in the cup");
  });

  it("renders a phase whose type it does not recognise, without inventing a unit", () => {
    const text = render(
      shapeDefinition(
        wire({
          name: "Odd",
          phases: [{ target: { end: 5 }, type: "SOMETHING_NEW" }],
        }),
      ),
    );

    expect(text).toContain("SOMETHING_NEW");
    expect(text).toContain("to 5");
    expect(text).not.toContain("to 5 bar");
    expect(text).not.toContain("to 5 ml/s");
  });

  it("omits what the machine did not send rather than labelling it", () => {
    const text = render(
      shapeDefinition(wire({ name: "Sparse", phases: [{}] })),
    );

    // Profiles built on the machine's own screen send no phase `name` at all,
    // so a placeholder here would print on nearly every phase of nearly every
    // profile. The phase leads with its type, or with nothing.
    expect(text).toContain("1.");
    expect(text).not.toContain("Unnamed");
    expect(text).not.toContain("Ends at:");
    expect(text).not.toContain("ramp");
  });

  it("leads with the type when the machine sent no phase name", () => {
    const text = render(
      shapeDefinition(
        wire({
          name: "Machine made",
          phases: [{ target: { end: 5 }, type: "FLOW" }],
        }),
      ),
    );

    expect(text).toContain("1. FLOW, ramp to 5 ml/s");
  });

  it("separates a phase name from its type", () => {
    const text = render(
      shapeDefinition(
        wire({
          name: "Named",
          phases: [{ name: "Preinfusion", target: { end: 4 }, type: "FLOW" }],
        }),
      ),
    );

    expect(text).toContain("1. **Preinfusion** — FLOW, ramp to 4 ml/s");
  });

  it("states the restriction unit caveat once, not per phase", () => {
    const text = render(
      shapeDefinition(
        wire({
          name: "Lever",
          phases: [
            { restriction: 4, type: "PRESSURE" },
            { restriction: 4, type: "PRESSURE" },
            { restriction: 4, type: "PRESSURE" },
          ],
        }),
      ),
    );

    expect(text.match(/does not state this field's unit/g)).toHaveLength(1);
    expect(text.match(/Restriction: 4/g)).toHaveLength(3);
  });

  it("reports a pressure hand-off as well as a flow one", () => {
    const text = render(
      shapeDefinition(
        wire({
          globalStopConditions: { switchToManualPressureCtrl: true },
          name: "Manual finish",
        }),
      ),
    );
    expect(text).toContain("Hands pressure control back to you");
  });

  it("renders a partial recipe without leaving gaps in the sentence", () => {
    const text = render(
      shapeDefinition(wire({ name: "Half", recipe: { coffeeIn: 18 } })),
    );

    expect(text).toContain("**Recipe:** 18 g in");
    expect(text).not.toContain("→");
  });

  it("omits the stop line entirely when the machine sent an empty block", () => {
    const text = render(
      shapeDefinition(wire({ globalStopConditions: {}, name: "None" })),
    );
    expect(text).not.toContain("**Stops when:**");
  });

  it("prints a zero restriction as no restriction at all", () => {
    const text = render(
      shapeDefinition(
        wire({ name: "Plain", phases: [{ restriction: 0, type: "MANUAL" }] }),
      ),
    );
    expect(text).not.toContain("Restriction:");
  });
});
