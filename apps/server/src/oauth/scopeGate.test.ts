import { describe, expect, it } from "vitest";
import { PROTECTED_TOOLS, protectedToolsIn } from "./scopeGate";

/**
 * The write tools, written down here and nowhere else in this file.
 *
 * Deliberately a literal rather than a second derivation from the annotations:
 * the point is that adding a write tool is a *deliberate* edit in two places,
 * so a tool that quietly loses `readOnlyHint: true` cannot slip into the
 * protected set unnoticed. Same reasoning as `NON_IDEMPOTENT_TOOLS` in
 * `server.test.ts`.
 */
const WRITE_TOOLS = ["delete_profile", "select_profile", "upload_profile"];

function toolCall(name: string) {
  return { id: 1, jsonrpc: "2.0", method: "tools/call", params: { name } };
}

describe("PROTECTED_TOOLS", () => {
  it("is exactly the tools annotated as not read-only", () => {
    expect([...PROTECTED_TOOLS].sort()).toEqual([...WRITE_TOOLS].sort());
  });
});

describe("protectedToolsIn", () => {
  it("names a protected tool call", () => {
    expect(protectedToolsIn(toolCall("select_profile"))).toEqual([
      "select_profile",
    ]);
  });

  it("ignores a read-only tool call", () => {
    expect(protectedToolsIn(toolCall("get_status"))).toEqual([]);
  });

  it("ignores methods that are not tools/call", () => {
    for (const method of ["initialize", "tools/list", "prompts/get"]) {
      expect(protectedToolsIn({ id: 1, jsonrpc: "2.0", method })).toEqual([]);
    }
  });

  it("finds a write hidden in a batch of reads", () => {
    // A batch whose first entry is harmless must not buy the whole array a
    // pass — the gate reads every message, not the first one.
    expect(
      protectedToolsIn([
        toolCall("get_status"),
        toolCall("upload_profile"),
        toolCall("list_profiles"),
      ]),
    ).toEqual(["upload_profile"]);
  });

  it("survives anything that is not a well-formed message", () => {
    // The body reaches this before the SDK has validated it, so every shape a
    // caller can POST has to return rather than throw.
    for (const body of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { method: "tools/call" },
      { method: "tools/call", params: null },
      { method: "tools/call", params: {} },
      { method: "tools/call", params: { name: 99 } },
      [null, { method: "tools/call", params: { name: "select_profile" } }],
    ]) {
      expect(() => protectedToolsIn(body)).not.toThrow();
    }
    expect(
      protectedToolsIn([
        null,
        { method: "tools/call", params: { name: "select_profile" } },
      ]),
    ).toEqual(["select_profile"]);
  });

  it("takes the protected set as a parameter, for the caller that has one", () => {
    expect(
      protectedToolsIn(toolCall("get_status"), new Set(["get_status"])),
    ).toEqual(["get_status"]);
  });
});
