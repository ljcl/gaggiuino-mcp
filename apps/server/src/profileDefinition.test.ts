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
});
