import { describe, expect, it } from "vitest";
import { ConfigError } from "./config";
import {
  authenticate,
  checkRequest,
  corsHeaders,
  describeSecurity,
  handlePreflight,
  loadSecurityConfig,
  type SecurityConfig,
  secretsMatch,
} from "./mcpAuth";
import { TEST_OAUTH_ENV, TEST_PASSPHRASE_HASH } from "./oauth/__fixtures__";
import { signToken } from "./oauth/tokens";

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

const ISSUER = "https://box.tail1234.ts.net";
const RESOURCE = `${ISSUER}/mcp`;
const SECRET = "s".repeat(64);
const NOW_MS = 1_000_000_000;

const OAUTH: SecurityConfig = {
  ...OPEN,
  oauth: { issuer: ISSUER, resource: RESOURCE, secret: SECRET },
};

function accessToken(scope = "espresso:read espresso:write"): string {
  return signToken(
    {
      aud: RESOURCE,
      exp: NOW_MS / 1000 + 3600,
      iat: NOW_MS / 1000,
      iss: ISSUER,
      jti: "id",
      scope,
      sub: "owner",
    },
    SECRET,
    "access-token",
  );
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://gaggiuino.local:8000/mcp", {
    headers,
    method: "POST",
  });
}

function preflight(headers: Record<string, string> = {}): Request {
  return new Request("http://gaggiuino.local:8000/mcp", {
    headers,
    method: "OPTIONS",
  });
}

describe("loadSecurityConfig", () => {
  it("serves unauthenticated when OAuth is not configured", () => {
    expect(loadSecurityConfig({})).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      oauth: undefined,
    });
  });

  it("ignores MCP_AUTH_TOKEN entirely", () => {
    // Nothing reads the removed shared secret any more — the 2.0.x startup
    // tombstone is gone too (#114) — so a stale value in a long-lived `.env`
    // must be an ignored variable, never something that re-gates `/mcp`.
    expect(loadSecurityConfig({ MCP_AUTH_TOKEN: "correct-horse" })).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      oauth: undefined,
    });
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

  it("rejects a request carrying no Host header at all", async () => {
    // An allowlist is a list of values to accept, so "sent nothing" is not on
    // it. Worth asserting separately because the absent case reaches a
    // different arm — the message has to name something, and `undefined`
    // interpolated into it would read as a host called "undefined".
    const response = checkRequest(request(), {
      ...OPEN,
      allowedHosts: ["gaggiuino.local:8000"],
    });
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error: { message: string } };
    expect(body.error.message).toContain("(none)");
  });
});

describe("checkRequest — credential", () => {
  it("lets every request through when OAuth is not configured", () => {
    expect(checkRequest(request(), OPEN)).toBeUndefined();
  });

  it("challenges a request with no Authorization header", async () => {
    const response = checkRequest(request(), OAUTH);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
    const body = (await response?.json()) as { jsonrpc: string };
    // JSON-RPC shaped so an MCP client surfaces something it can parse.
    expect(body.jsonrpc).toBe("2.0");
  });

  it("rejects a bare credential with no scheme", () => {
    expect(
      checkRequest(request({ authorization: "correct-horse" }), OAUTH)?.status,
    ).toBe(401);
  });
});

describe("checkRequest — ordering", () => {
  it("answers a disallowed origin with 403 even when the token is missing", async () => {
    // If auth ran first, the 401/403 split would tell an unauthenticated
    // cross-origin prober whether authentication is configured at all.
    const config: SecurityConfig = {
      ...OAUTH,
      allowedOrigins: ["https://claude.ai"],
    };
    const response = checkRequest(
      request({ origin: "https://evil.test" }),
      config,
    );
    expect(response?.status).toBe(403);
  });
});

describe("corsHeaders", () => {
  const ALLOWED: SecurityConfig = {
    allowedHosts: [],
    allowedOrigins: ["https://claude.ai"],
  };

  it("says nothing when there is no Origin to answer", () => {
    // A non-browser client needs no CORS headers, and emitting them anyway
    // would advertise the allowlist to anything that asks.
    expect(corsHeaders(request(), ALLOWED)).toEqual({});
  });

  it("says nothing to an origin outside the allowlist", () => {
    expect(
      corsHeaders(request({ origin: "https://evil.test" }), ALLOWED),
    ).toEqual({});
  });

  it("echoes an allowed origin and exposes the session header", () => {
    // Passing the origin check is only half a cross-origin request: without
    // these the browser discards a reply the server was happy to send, and
    // `mcp-session-id` is not CORS-safelisted, so a client that cannot read it
    // has no session to continue with.
    expect(
      corsHeaders(request({ origin: "https://claude.ai" }), ALLOWED),
    ).toEqual({
      "Access-Control-Allow-Origin": "https://claude.ai",
      "Access-Control-Expose-Headers": "mcp-session-id",
      Vary: "Origin",
    });
  });

  it("echoes the caller's origin under the wildcard rather than returning *", () => {
    const config: SecurityConfig = { allowedHosts: [], allowedOrigins: ["*"] };
    expect(
      corsHeaders(request({ origin: "https://anything.test" }), config)[
        "Access-Control-Allow-Origin"
      ],
    ).toBe("https://anything.test");
  });
});

describe("handlePreflight", () => {
  const ALLOWED: SecurityConfig = {
    ...OAUTH,
    allowedOrigins: ["https://claude.ai"],
  };

  it("ignores anything that is not an OPTIONS request", () => {
    expect(
      handlePreflight(request({ origin: "https://claude.ai" }), ALLOWED),
    ).toBe(undefined);
  });

  it("answers an allowed origin without requiring the token", () => {
    // A browser sends the preflight with no Authorization header by design, so
    // gating it on the token rejects every credentialed cross-origin request
    // before it is ever made.
    const response = handlePreflight(
      preflight({ origin: "https://claude.ai" }),
      ALLOWED,
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://claude.ai",
    );
    expect(response?.headers.get("Access-Control-Allow-Methods")).toContain(
      "DELETE",
    );
  });

  it("permits every header a Streamable HTTP client sends", () => {
    // Omitting one makes the browser fail the preflight for a request the
    // allowlist was meant to permit.
    const allowed = handlePreflight(
      preflight({ origin: "https://claude.ai" }),
      ALLOWED,
    )?.headers.get("Access-Control-Allow-Headers");
    for (const header of [
      "authorization",
      "content-type",
      "last-event-id",
      "mcp-protocol-version",
      "mcp-session-id",
    ]) {
      expect(allowed).toContain(header);
    }
  });

  it("refuses a preflight from an origin outside the allowlist", () => {
    const response = handlePreflight(
      preflight({ origin: "https://evil.test" }),
      ALLOWED,
    );
    expect(response?.status).toBe(403);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });
});

describe("loadSecurityConfig — OAuth", () => {
  const COMPLETE = TEST_OAUTH_ENV;

  it("stays unconfigured when neither variable is set", () => {
    expect(loadSecurityConfig({}).oauth).toBeUndefined();
  });

  it("derives the resource by appending /mcp to the public origin", () => {
    // This must equal the URL the user types into Claude, path included.
    expect(loadSecurityConfig(COMPLETE).oauth).toEqual({
      issuer: ISSUER,
      passphraseHash: TEST_PASSPHRASE_HASH,
      resource: RESOURCE,
      secret: SECRET,
    });
  });

  it("refuses to enable OAuth with no consent passphrase", () => {
    // Without one, /oauth/authorize would hand a token to anyone who reached
    // the URL — so this is a startup failure rather than a degraded mode.
    const { MCP_OAUTH_PASSPHRASE_HASH: _omitted, ...rest } = COMPLETE;
    expect(() => loadSecurityConfig(rest)).toThrow(ConfigError);
    expect(() => loadSecurityConfig(rest)).toThrow(/PASSPHRASE/);
  });

  it("refuses a passphrase hash that is not a scrypt hash", () => {
    // The likely mistake is pasting the passphrase itself into the variable.
    expect(() =>
      loadSecurityConfig({
        ...COMPLETE,
        MCP_OAUTH_PASSPHRASE_HASH: "hunter2",
      }),
    ).toThrow(ConfigError);
  });

  it("fails startup when only half of it is configured", () => {
    // Silently falling back to the previous behaviour is how somebody exposes
    // a tunnel believing it is OAuth-gated.
    expect(() => loadSecurityConfig({ MCP_PUBLIC_URL: ISSUER })).toThrow(
      ConfigError,
    );
    expect(() => loadSecurityConfig({ MCP_PUBLIC_URL: ISSUER })).toThrow(
      /MCP_OAUTH_SECRET/,
    );
    expect(() => loadSecurityConfig({ MCP_OAUTH_SECRET: SECRET })).toThrow(
      /MCP_PUBLIC_URL/,
    );
  });

  it("treats a blank value as unset on both variables", () => {
    expect(
      loadSecurityConfig({ MCP_OAUTH_SECRET: "  ", MCP_PUBLIC_URL: "  " })
        .oauth,
    ).toBeUndefined();
  });

  it("refuses a secret short enough to have been typed by hand", () => {
    expect(() =>
      loadSecurityConfig({ ...COMPLETE, MCP_OAUTH_SECRET: "hunter2" }),
    ).toThrow(ConfigError);
  });
});

describe("authenticate — OAuth", () => {
  function withToken(token: string): Request {
    return request({ authorization: `Bearer ${token}` });
  }

  it("grants the token's scopes and names its subject", () => {
    const outcome = authenticate(withToken(accessToken()), OAUTH, () => NOW_MS);
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.grant).toEqual({
      mode: "oauth",
      scopes: ["espresso:read", "espresso:write"],
      subject: "owner",
    });
  });

  it("grants only what the token carries", () => {
    const outcome = authenticate(
      withToken(accessToken("espresso:read")),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.grant.scopes).toEqual(["espresso:read"]);
  });

  it("refuses a request with no Authorization header", () => {
    const outcome = authenticate(request(), OAUTH, () => NOW_MS);
    expect(outcome.refusal?.status).toBe(401);
    expect(outcome.reason).toBe("missing");
    expect(outcome.grant.scopes).toEqual([]);
  });

  it("distinguishes a malformed header from an absent one, for the log", () => {
    // The field that separates "the client never sent it" from "it sent
    // something unusable" — which is the evidence an upstream bug report needs.
    const outcome = authenticate(
      request({ authorization: "Basic abc" }),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.reason).toBe("malformed-header");
  });

  it("carries the verification failure into the log and not the response", () => {
    const expired = signToken(
      {
        aud: RESOURCE,
        exp: NOW_MS / 1000 - 1,
        iat: NOW_MS / 1000 - 3600,
        iss: ISSUER,
        jti: "id",
        scope: "espresso:read",
        sub: "owner",
      },
      SECRET,
      "access-token",
    );
    const outcome = authenticate(withToken(expired), OAUTH, () => NOW_MS);
    expect(outcome.reason).toBe("expired");
    expect(outcome.refusal?.status).toBe(401);
  });

  it("points every refusal at the metadata document", () => {
    for (const req of [request(), withToken("garbage")]) {
      const header = authenticate(
        req,
        OAUTH,
        () => NOW_MS,
      ).refusal?.headers.get("WWW-Authenticate");
      expect(header).toContain(
        'resource_metadata="https://box.tail1234.ts.net/.well-known/oauth-protected-resource/mcp"',
      );
      expect(header).toContain('scope="espresso:read espresso:write"');
    }
  });

  it("refuses a credential that is not one of its own access tokens", () => {
    // The shape a deployment that never migrated would present: whatever it
    // used to send as MCP_AUTH_TOKEN. There is no second credential path left
    // for it to fall into, so it fails verification like any other bad token.
    const outcome = authenticate(
      request({ authorization: "Bearer correct-horse-battery-staple" }),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.refusal?.status).toBe(401);
    expect(outcome.grant).toEqual({ mode: "oauth", scopes: [] });
  });

  it("grants every scope when nothing is configured", () => {
    // Not a hole: the write tools are refused by `writeToolDisabled` with text
    // that explains there is no way to authenticate. A 403 here would point at
    // an authorization server that does not exist.
    expect(authenticate(request(), OPEN).grant).toEqual({
      mode: "none",
      scopes: ["espresso:read", "espresso:write"],
    });
  });

  it("ignores an Authorization header when nothing is configured", () => {
    // An unconfigured server has nothing to check a credential against, so a
    // presented one is neither honoured nor a reason to refuse.
    expect(
      authenticate(request({ authorization: "Bearer anything" }), OPEN).grant,
    ).toEqual({ mode: "none", scopes: ["espresso:read", "espresso:write"] });
  });

  it("defaults its clock to the real one", () => {
    expect(authenticate(withToken(accessToken()), OAUTH).refusal?.status).toBe(
      401,
    );
  });
});

describe("checkRequest — OAuth", () => {
  it("still checks Origin before the credential", () => {
    // Otherwise the 401/403 split tells an unauthenticated cross-origin prober
    // whether authentication is configured at all.
    const config = { ...OAUTH, allowedOrigins: ["https://claude.ai"] };
    expect(
      checkRequest(request({ origin: "https://evil.test" }), config)?.status,
    ).toBe(403);
  });

  it("refuses an unauthenticated request with a discoverable 401", () => {
    const response = checkRequest(request(), OAUTH);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("accepts a precomputed authentication rather than redoing it", () => {
    const req = request({ authorization: `Bearer ${accessToken()}` });
    const auth = authenticate(req, OAUTH, () => NOW_MS);
    expect(checkRequest(req, OAUTH, auth)).toBeUndefined();
  });
});

describe("describeSecurity", () => {
  function report(config: SecurityConfig, event: string) {
    return describeSecurity(config).find((entry) => entry.event === event);
  }

  it("warns at warn level when the endpoint is unauthenticated", () => {
    const entry = report(OPEN, "security.unauthenticated");
    expect(entry?.level).toBe("warn");
    // Every variable needed to act on the warning, including the passphrase
    // hash: leave it out and the operator sets the other two and the server
    // then refuses to start, which reads as the advice having been wrong.
    for (const name of [
      "MCP_PUBLIC_URL",
      "MCP_OAUTH_SECRET",
      "MCP_OAUTH_PASSPHRASE_HASH",
    ]) {
      expect(String(entry?.fields.message)).toContain(name);
    }
  });

  it("says the removed shared secret is not an alternative", () => {
    // The warning used to end by offering MCP_AUTH_TOKEN to clients that can
    // set their own headers. Someone following that now writes a variable that
    // stops the server from booting at all.
    const message = String(
      report(OPEN, "security.unauthenticated")?.fields.message,
    );
    expect(message).toContain("MCP_AUTH_TOKEN was removed");
  });

  it("reports the gate instead of warning once OAuth is set", () => {
    expect(report(OAUTH, "security.unauthenticated")).toBeUndefined();
    expect(report(OAUTH, "security.auth")?.fields.mode).toBe("oauth");
  });

  it("prints the advertised resource verbatim under OAuth", () => {
    // The one value that has to be right and fails silently when it is not:
    // a `resource` that disagrees with the URL the user typed into Claude
    // still completes discovery and still issues a token, and then 401s every
    // request. An operator can only check it if it is printed.
    const entry = report(OAUTH, "security.auth");
    expect(entry?.level).toBe("info");
    expect(entry?.fields.mode).toBe("oauth");
    expect(entry?.fields.resource).toBe(RESOURCE);
    expect(String(entry?.fields.message)).toContain(RESOURCE);
  });

  it("warns about the wildcard, the one unsafe origin setting", () => {
    const entry = report(
      { ...OAUTH, allowedOrigins: ["*"] },
      "security.origins",
    );
    expect(entry?.level).toBe("warn");
    expect(entry?.fields.allowed).toBe("*");
  });

  it("lists the configured origins so they can be read back", () => {
    const entry = report(
      { ...OAUTH, allowedOrigins: ["https://claude.ai", "https://a.test"] },
      "security.origins",
    );
    expect(entry?.level).toBe("info");
    expect(String(entry?.fields.message)).toContain(
      "https://claude.ai, https://a.test",
    );
  });

  it("explains the empty allowlist rather than looking like a misconfiguration", () => {
    const entry = report(OAUTH, "security.origins");
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
