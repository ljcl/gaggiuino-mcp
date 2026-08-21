import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/core";
import { describe, expect, it } from "vitest";
import { TEST_OAUTH_CONFIG } from "./__fixtures__";
import {
  handleMetadataRequest,
  insufficientScopeChallenge,
  invalidTokenChallenge,
  type OAuthConfig,
  PROTECTED_RESOURCE_PATHS,
  protectedResourceMetadata,
} from "./metadata";

const CONFIG: OAuthConfig = TEST_OAUTH_CONFIG;

/**
 * Parse a `WWW-Authenticate: Bearer k="v", k="v"` header into its parameters,
 * so assertions name the parameter rather than matching a substring of the
 * whole header — which would pass on a value that landed in the wrong key.
 */
function challengeParams(header: string): Record<string, string> {
  expect(header.startsWith("Bearer ")).toBe(true);
  const params: Record<string, string> = {};
  for (const [, key, value] of header
    .slice("Bearer ".length)
    .matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
    if (key) params[key] = (value ?? "").replace(/\\(.)/g, "$1");
  }
  return params;
}

describe("protectedResourceMetadata", () => {
  it("validates against the SDK's own RFC 9728 schema", () => {
    // The document is generated and validated rather than hand-typed, the same
    // rule `toJsonSchema` applies to tool schemas.
    expect(() =>
      OAuthProtectedResourceMetadataSchema.parse(
        protectedResourceMetadata(CONFIG),
      ),
    ).not.toThrow();
  });

  it("advertises the resource, the issuer and both scopes", () => {
    expect(protectedResourceMetadata(CONFIG)).toMatchObject({
      authorization_servers: [CONFIG.issuer],
      bearer_methods_supported: ["header"],
      resource: CONFIG.resource,
      scopes_supported: ["espresso:read", "espresso:write"],
    });
  });
});

describe("handleMetadataRequest", () => {
  it("serves the same body on both well-known paths", async () => {
    const [suffixed, bare] = PROTECTED_RESOURCE_PATHS;
    // Claude probes the path-suffixed form first when the resource URL has a
    // path, and Anthropic's own diagnostic checklist curls the bare one. A
    // server that answers only one of them fails a check meant to pass.
    const first = handleMetadataRequest(suffixed, CONFIG);
    const second = handleMetadataRequest(bare, CONFIG);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await first?.json()).toEqual(await second?.json());
  });

  it("does not mount the routes while OAuth is unconfigured", () => {
    // An unconfigured server is byte-for-byte what it was before OAuth existed.
    for (const path of PROTECTED_RESOURCE_PATHS) {
      expect(handleMetadataRequest(path, undefined)).toBeUndefined();
    }
  });

  it("ignores paths that are not well-known documents", () => {
    expect(handleMetadataRequest("/mcp", CONFIG)).toBeUndefined();
    expect(
      handleMetadataRequest(
        "/.well-known/oauth-protected-resource/other",
        CONFIG,
      ),
    ).toBeUndefined();
  });

  it("bounds how long the document may be cached", () => {
    const response = handleMetadataRequest(PROTECTED_RESOURCE_PATHS[0], CONFIG);
    expect(response?.headers.get("Cache-Control")).toContain("max-age=300");
  });
});

describe("invalidTokenChallenge", () => {
  it("points at the metadata document and names both scopes", () => {
    const params = challengeParams(invalidTokenChallenge(CONFIG));
    expect(params.error).toBe("invalid_token");
    // Without this pointer the client gets a 401 it cannot act on — the
    // documented cause of "Couldn't reach the MCP server."
    expect(params.resource_metadata).toBe(
      `${CONFIG.issuer}${PROTECTED_RESOURCE_PATHS[0]}`,
    );
    // Omitting `scope` makes Claude request everything in `scopes_supported`,
    // producing a broader consent prompt than the request needs.
    expect(params.scope).toBe("espresso:read espresso:write");
  });
});

describe("insufficientScopeChallenge", () => {
  it("uses the insufficient_scope code and still names every scope", () => {
    const params = challengeParams(insufficientScopeChallenge(CONFIG));
    expect(params.error).toBe("insufficient_scope");
    // Not just the missing one: scopes picked up in an earlier step-up are not
    // reliably carried forward, so naming only `espresso:write` loses the read
    // scope the caller already had.
    expect(params.scope).toBe("espresso:read espresso:write");
  });
});

describe("challenge encoding", () => {
  it("escapes quotes so a value cannot terminate its own parameter", () => {
    // `publicOrigin`, not `issuer`: the pointer names where *this server*
    // publishes its protected-resource metadata, and with an external issuer
    // those are different hosts.
    const header = invalidTokenChallenge({
      ...CONFIG,
      publicOrigin: 'https://evil.test/"x\\y',
    });
    expect(header).toContain('\\"');
    expect(challengeParams(header).resource_metadata).toBe(
      'https://evil.test/"x\\y/.well-known/oauth-protected-resource/mcp',
    );
  });
});
