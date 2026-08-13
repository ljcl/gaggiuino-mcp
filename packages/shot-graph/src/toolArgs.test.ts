import { describe, expect, it } from "vitest";
import { parseToolArgs } from "./toolArgs";

describe("parseToolArgs", () => {
  it("passes a string id through", () => {
    expect(parseToolArgs({ shot_id: "362" })).toEqual({
      compare_shot_id: undefined,
      shot_id: "362",
    });
  });

  it("coerces a numeric id, exactly as the server's schema does", () => {
    // The advertised input schema is `string | number` and the host relays the
    // call arguments untransformed. A numeric id used to fail the parser's
    // typeof check and strand the app on "Waiting for shot data…" with no
    // error — the tool call itself having succeeded (Claude iOS, 2026-08-13).
    expect(parseToolArgs({ shot_id: 363 })).toEqual({
      compare_shot_id: undefined,
      shot_id: "363",
    });
  });

  it("coerces a numeric comparison id", () => {
    expect(parseToolArgs({ compare_shot_id: 362, shot_id: 363 })).toEqual({
      compare_shot_id: "362",
      shot_id: "363",
    });
  });

  it("drops a malformed comparison id rather than the whole input", () => {
    expect(parseToolArgs({ compare_shot_id: "", shot_id: "363" })).toEqual({
      compare_shot_id: undefined,
      shot_id: "363",
    });
  });

  it("rejects an empty-string id", () => {
    expect(parseToolArgs({ shot_id: "" })).toBeNull();
  });

  it("rejects a non-finite numeric id", () => {
    expect(parseToolArgs({ shot_id: Number.NaN })).toBeNull();
  });

  it("rejects absent arguments", () => {
    expect(parseToolArgs(undefined)).toBeNull();
    expect(parseToolArgs({})).toBeNull();
  });
});
