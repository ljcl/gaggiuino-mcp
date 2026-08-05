import { describe, expect, it } from "vitest";
import { ALL_SCOPES, ALL_SCOPES_HEADER, parseScopes } from "./scopes";

describe("ALL_SCOPES", () => {
  it("is the read/write split the tool annotations already declare", () => {
    expect(ALL_SCOPES).toEqual(["espresso:read", "espresso:write"]);
    expect(ALL_SCOPES_HEADER).toBe("espresso:read espresso:write");
  });
});

describe("parseScopes", () => {
  it("splits the space-delimited claim RFC 6749 specifies", () => {
    expect(parseScopes("espresso:read espresso:write")).toEqual([
      "espresso:read",
      "espresso:write",
    ]);
  });

  it("treats an absent or empty claim as no scopes", () => {
    // A token with no `scope` grants nothing, rather than everything.
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("tolerates the whitespace a hand-built token arrives with", () => {
    expect(parseScopes("  espresso:read   espresso:write  ")).toEqual([
      "espresso:read",
      "espresso:write",
    ]);
  });
});
