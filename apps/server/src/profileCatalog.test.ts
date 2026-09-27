import { describe, expect, it } from "vitest";
import { type CatalogEntry, describeCandidates } from "./profileCatalog";

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    basketNotes: null,
    description: null,
    documented: false,
    id: "profile-1",
    machineName: null,
    machineProfileId: null,
    name: "Zer0",
    onMachine: true,
    recommendedDose: null,
    roastLevels: [],
    targetRatio: null,
    targetTime: null,
    type: null,
    ...overrides,
  };
}

describe("describeCandidates", () => {
  it("names each candidate by the key that tells it apart", () => {
    // The machine id where there is one, because that is what the caller can
    // pass back to step out of the ambiguity; the catalog id otherwise.
    expect(
      describeCandidates([
        entry({ machineName: "zer0", machineProfileId: "15" }),
        entry({ id: "profile-2" }),
      ]),
    ).toBe("machineProfileId 15 ('zer0'), id profile-2 ('Zer0')");
  });
});
