import { describe, expect, it } from "vitest";
import {
  checkRequest,
  describeSecurity,
  loadSecurityConfig,
  type SecurityConfig,
  secretsMatch,
} from "./mcpAuth";

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://gaggiuino.local:8000/mcp", {
    headers,
    method: "POST",
  });
}

describe("loadSecurityConfig", () => {
  it("serves unauthenticated when no token is set", () => {
    expect(loadSecurityConfig({})).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      token: undefined,
    });
  });

  it("treats a blank token as no token rather than as an empty secret", () => {
    // Otherwise `MCP_AUTH_TOKEN=` in a compose file would look configured
    // while accepting `Authorization: Bearer ` from anyone.
    expect(loadSecurityConfig({ MCP_AUTH_TOKEN: "   " }).token).toBeUndefined();
  });

  it("splits and trims the comma-separated allowlists", () => {
    const config = loadSecurityConfig({
      MCP_ALLOWED_HOSTS: "gaggiuino.local:8000",
      MCP_ALLOWED_ORIGINS: "https://claude.ai, https://example.test ,",
    });
    expect(config.allowedOrigins).toEqual([
      "https://claude.ai",
      "https://example.test",
    ]);
    expect(config.allowedHosts).toEqual(["gaggiuino.local:8000"]);
  });
});

describe("secretsMatch", () => {
  it("accepts an exact match and rejects anything else", () => {
    expect(secretsMatch("s3cret", "s3cret")).toBe(true);
    expect(secretsMatch("s3cret", "s3crey")).toBe(false);
  });

  it("compares values of different lengths without throwing", () => {
    // node's timingSafeEqual throws on a length mismatch, and guarding with an
    // early length check is what leaks the secret's length. Hashing first is
    // the reason this case is a plain `false`.
    expect(secretsMatch("short", "a-much-longer-token")).toBe(false);
    expect(secretsMatch("", "token")).toBe(false);
  });
});

describe("checkRequest — origin", () => {
  it("allows requests with no Origin header", () => {
    // curl, Claude Desktop, the container healthcheck: not browsers, so not
    // the confused-deputy case the allowlist exists for.
    expect(checkRequest(request(), OPEN)).toBeUndefined();
  });

  it("rejects a browser origin when the allowlist is empty", async () => {
    const response = checkRequest(
      request({ origin: "https://evil.example" }),
      OPEN,
    );
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error: { message: string } };
    expect(body.error.message).toContain("https://evil.example");
  });

  it("allows an origin on the allowlist", () => {
    const config = { ...OPEN, allowedOrigins: ["https://claude.ai"] };
    expect(
      checkRequest(request({ origin: "https://claude.ai" }), config),
    ).toBeUndefined();
    expect(
      checkRequest(request({ origin: "https://claude.ai.evil.test" }), config),
    ).toBeDefined();
  });

  it("honours the explicit wildcard escape hatch", () => {
    const config = { ...OPEN, allowedOrigins: ["*"] };
    expect(
      checkRequest(request({ origin: "https://anything.test" }), config),
    ).toBeUndefined();
  });
});

describe("checkRequest — host", () => {
  it("skips host validation when no allowlist is configured", () => {
    expect(
      checkRequest(request({ host: "whatever.test" }), OPEN),
    ).toBeUndefined();
  });

  it("rejects a host outside the allowlist", () => {
    const config = { ...OPEN, allowedHosts: ["gaggiuino.local:8000"] };
    expect(
      checkRequest(request({ host: "attacker.test" }), config)?.status,
    ).toBe(403);
    expect(
      checkRequest(request({ host: "gaggiuino.local:8000" }), config),
    ).toBeUndefined();
  });
});

describe("checkRequest — token", () => {
  const config: SecurityConfig = { ...OPEN, token: "correct-horse" };

  it("lets every request through when no token is configured", () => {
    expect(checkRequest(request(), OPEN)).toBeUndefined();
  });

  it("challenges a request with no Authorization header", async () => {
    const response = checkRequest(request(), config);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="gaggiuino-mcp"',
    );
    const body = (await response?.json()) as { jsonrpc: string };
    // JSON-RPC shaped so an MCP client surfaces something it can parse.
    expect(body.jsonrpc).toBe("2.0");
  });

  it("rejects a wrong token and accepts the right one", () => {
    expect(
      checkRequest(request({ authorization: "Bearer wrong" }), config)?.status,
    ).toBe(401);
    expect(
      checkRequest(request({ authorization: "Bearer correct-horse" }), config),
    ).toBeUndefined();
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    expect(
      checkRequest(request({ authorization: "bearer correct-horse" }), config),
    ).toBeUndefined();
  });

  it("rejects a bare token with no scheme", () => {
    expect(
      checkRequest(request({ authorization: "correct-horse" }), config)?.status,
    ).toBe(401);
  });
});

describe("checkRequest — ordering", () => {
  it("answers a disallowed origin with 403 even when the token is missing", async () => {
    // If auth ran first, the 401/403 split would tell an unauthenticated
    // cross-origin prober whether a token is configured at all.
    const config: SecurityConfig = {
      allowedHosts: [],
      allowedOrigins: ["https://claude.ai"],
      token: "correct-horse",
    };
    const response = checkRequest(
      request({ origin: "https://evil.test" }),
      config,
    );
    expect(response?.status).toBe(403);
  });
});

describe("describeSecurity", () => {
  function report(config: SecurityConfig, event: string) {
    return describeSecurity(config).find((entry) => entry.event === event);
  }

  it("warns at warn level when the endpoint is unauthenticated", () => {
    const entry = report(OPEN, "security.unauthenticated");
    expect(entry?.level).toBe("warn");
    expect(String(entry?.fields.message)).toContain("MCP_AUTH_TOKEN");
  });

  it("reports the gate instead of warning once a token is set", () => {
    const gated = { ...OPEN, token: "t" };
    expect(report(gated, "security.unauthenticated")).toBeUndefined();
    expect(report(gated, "security.auth")?.fields.mode).toBe("bearer");
  });

  it("warns about the wildcard, the one unsafe origin setting", () => {
    const entry = report(
      { ...OPEN, allowedOrigins: ["*"], token: "t" },
      "security.origins",
    );
    expect(entry?.level).toBe("warn");
    expect(entry?.fields.allowed).toBe("*");
  });

  it("explains the empty allowlist rather than looking like a misconfiguration", () => {
    const entry = report({ ...OPEN, token: "t" }, "security.origins");
    expect(entry?.level).toBe("info");
    expect(String(entry?.fields.message)).toContain("without an Origin header");
  });

  it("mentions the host allowlist only when one is configured", () => {
    expect(report(OPEN, "security.hosts")).toBeUndefined();
    expect(
      report({ ...OPEN, allowedHosts: ["a.test"] }, "security.hosts")?.fields
        .allowed,
    ).toEqual(["a.test"]);
  });
});
