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
import {
  TEST_EXTERNAL_ISSUER,
  TEST_OAUTH_CONFIG,
  TEST_OAUTH_ENV,
  TEST_PASSPHRASE_HASH,
} from "./oauth/__fixtures__";
import { signToken } from "./oauth/tokens";

const OPEN: SecurityConfig = { allowedHosts: [], allowedOrigins: [] };

const ISSUER = "https://box.tail1234.ts.net";
const RESOURCE = `${ISSUER}/mcp`;
const SECRET = "s".repeat(64);
const NOW_MS = 1_000_000_000;

const OAUTH: SecurityConfig = { ...OPEN, oauth: TEST_OAUTH_CONFIG };

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
  it("serves unauthenticated when OAuth is not configured", async () => {
    expect(loadSecurityConfig({})).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      oauth: undefined,
    });
  });

  it("ignores MCP_AUTH_TOKEN entirely", async () => {
    // Nothing reads MCP_AUTH_TOKEN, so a stale value in a long-lived `.env`
    // must be an ignored variable, never something that re-gates `/mcp`.
    expect(loadSecurityConfig({ MCP_AUTH_TOKEN: "correct-horse" })).toEqual({
      allowedHosts: [],
      allowedOrigins: [],
      oauth: undefined,
    });
  });

  it("splits and trims the comma-separated allowlists", async () => {
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
  it("accepts an exact match and rejects anything else", async () => {
    expect(secretsMatch("s3cret", "s3cret")).toBe(true);
    expect(secretsMatch("s3cret", "s3crey")).toBe(false);
  });

  it("compares values of different lengths without throwing", async () => {
    // node's timingSafeEqual throws on a length mismatch, and guarding with an
    // early length check is what leaks the secret's length. Hashing first is
    // the reason this case is a plain `false`.
    expect(secretsMatch("short", "a-much-longer-token")).toBe(false);
    expect(secretsMatch("", "token")).toBe(false);
  });
});

describe("checkRequest — origin", () => {
  it("allows requests with no Origin header", async () => {
    // curl, Claude Desktop, the container healthcheck: not browsers, so not
    // the confused-deputy case the allowlist exists for.
    expect(await checkRequest(request(), OPEN)).toBeUndefined();
  });

  it("rejects a browser origin when the allowlist is empty", async () => {
    const response = await checkRequest(
      request({ origin: "https://evil.example" }),
      OPEN,
    );
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error: { message: string } };
    expect(body.error.message).toContain("https://evil.example");
  });

  it("allows an origin on the allowlist", async () => {
    const config = { ...OPEN, allowedOrigins: ["https://claude.ai"] };
    expect(
      await checkRequest(request({ origin: "https://claude.ai" }), config),
    ).toBeUndefined();
    expect(
      await checkRequest(
        request({ origin: "https://claude.ai.evil.test" }),
        config,
      ),
    ).toBeDefined();
  });

  it("honours the explicit wildcard escape hatch", async () => {
    const config = { ...OPEN, allowedOrigins: ["*"] };
    expect(
      await checkRequest(request({ origin: "https://anything.test" }), config),
    ).toBeUndefined();
  });
});

describe("checkRequest — host", () => {
  it("skips host validation when no allowlist is configured", async () => {
    expect(
      await checkRequest(request({ host: "whatever.test" }), OPEN),
    ).toBeUndefined();
  });

  it("rejects a host outside the allowlist", async () => {
    const config = { ...OPEN, allowedHosts: ["gaggiuino.local:8000"] };
    expect(
      (await checkRequest(request({ host: "attacker.test" }), config))?.status,
    ).toBe(403);
    expect(
      await checkRequest(request({ host: "gaggiuino.local:8000" }), config),
    ).toBeUndefined();
  });

  it("rejects a request carrying no Host header at all", async () => {
    // An allowlist is a list of values to accept, so "sent nothing" is not on
    // it. Worth asserting separately because the absent case reaches a
    // different arm — the message has to name something, and `undefined`
    // interpolated into it would read as a host called "undefined".
    const response = await checkRequest(request(), {
      ...OPEN,
      allowedHosts: ["gaggiuino.local:8000"],
    });
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error: { message: string } };
    expect(body.error.message).toContain("(none)");
  });
});

describe("checkRequest — credential", () => {
  it("lets every request through when OAuth is not configured", async () => {
    expect(await checkRequest(request(), OPEN)).toBeUndefined();
  });

  it("challenges a request with no Authorization header", async () => {
    const response = await checkRequest(request(), OAUTH);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
    const body = (await response?.json()) as { jsonrpc: string };
    // JSON-RPC shaped so an MCP client surfaces something it can parse.
    expect(body.jsonrpc).toBe("2.0");
  });

  it("rejects a bare credential with no scheme", async () => {
    expect(
      (await checkRequest(request({ authorization: "correct-horse" }), OAUTH))
        ?.status,
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
    const response = await checkRequest(
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

  it("says nothing when there is no Origin to answer", async () => {
    // A non-browser client needs no CORS headers, and emitting them anyway
    // would advertise the allowlist to anything that asks.
    expect(corsHeaders(request(), ALLOWED)).toEqual({});
  });

  it("says nothing to an origin outside the allowlist", async () => {
    expect(
      corsHeaders(request({ origin: "https://evil.test" }), ALLOWED),
    ).toEqual({});
  });

  it("echoes an allowed origin and exposes the session header", async () => {
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

  it("echoes the caller's origin under the wildcard rather than returning *", async () => {
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

  it("ignores anything that is not an OPTIONS request", async () => {
    expect(
      handlePreflight(request({ origin: "https://claude.ai" }), ALLOWED),
    ).toBe(undefined);
  });

  it("answers an allowed origin without requiring the token", async () => {
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

  it("permits every header a Streamable HTTP client sends", async () => {
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

  it("refuses a preflight from an origin outside the allowlist", async () => {
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

  it("stays unconfigured when neither variable is set", async () => {
    expect(loadSecurityConfig({}).oauth).toBeUndefined();
  });

  it("derives the resource by appending /mcp to the public origin", async () => {
    // This must equal the URL the user types into Claude, path included.
    expect(loadSecurityConfig(COMPLETE).oauth).toEqual({
      // Equal on purpose: with the built-in authorization server this server
      // both mints the tokens and answers as the resource. The delegated tests
      // below are where the two come apart.
      issuer: ISSUER,
      passphraseHash: TEST_PASSPHRASE_HASH,
      publicOrigin: ISSUER,
      resource: RESOURCE,
      secret: SECRET,
    });
  });

  it("refuses to enable OAuth with no consent passphrase", async () => {
    // Without one, /oauth/authorize would hand a token to anyone who reached
    // the URL — so this is a startup failure rather than a degraded mode.
    const { MCP_OAUTH_PASSPHRASE_HASH: _omitted, ...rest } = COMPLETE;
    expect(() => loadSecurityConfig(rest)).toThrow(ConfigError);
    expect(() => loadSecurityConfig(rest)).toThrow(/PASSPHRASE/);
  });

  it("refuses a passphrase hash that is not a scrypt hash", async () => {
    // The likely mistake is pasting the passphrase itself into the variable.
    expect(() =>
      loadSecurityConfig({
        ...COMPLETE,
        MCP_OAUTH_PASSPHRASE_HASH: "hunter2",
      }),
    ).toThrow(ConfigError);
  });

  it("fails startup when only half of it is configured", async () => {
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

  it("treats a blank value as unset on both variables", async () => {
    expect(
      loadSecurityConfig({ MCP_OAUTH_SECRET: "  ", MCP_PUBLIC_URL: "  " })
        .oauth,
    ).toBeUndefined();
  });

  it("refuses a secret short enough to have been typed by hand", async () => {
    expect(() =>
      loadSecurityConfig({ ...COMPLETE, MCP_OAUTH_SECRET: "hunter2" }),
    ).toThrow(ConfigError);
  });
});

describe("authenticate — OAuth", () => {
  function withToken(token: string): Request {
    return request({ authorization: `Bearer ${token}` });
  }

  it("grants the token's scopes and names its subject", async () => {
    const outcome = await authenticate(
      withToken(accessToken()),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.grant).toEqual({
      mode: "oauth",
      scopes: ["espresso:read", "espresso:write"],
      subject: "owner",
    });
  });

  it("grants only what the token carries", async () => {
    const outcome = await authenticate(
      withToken(accessToken("espresso:read")),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.grant.scopes).toEqual(["espresso:read"]);
  });

  it("refuses a request with no Authorization header", async () => {
    const outcome = await authenticate(request(), OAUTH, () => NOW_MS);
    expect(outcome.refusal?.status).toBe(401);
    expect(outcome.reason).toBe("missing");
    expect(outcome.grant.scopes).toEqual([]);
  });

  it("distinguishes a malformed header from an absent one, for the log", async () => {
    // The field that separates "the client never sent it" from "it sent
    // something unusable" — which is the evidence an upstream bug report needs.
    const outcome = await authenticate(
      request({ authorization: "Basic abc" }),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.reason).toBe("malformed-header");
  });

  it("carries the verification failure into the log and not the response", async () => {
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
    const outcome = await authenticate(withToken(expired), OAUTH, () => NOW_MS);
    expect(outcome.reason).toBe("expired");
    expect(outcome.refusal?.status).toBe(401);
  });

  it("points every refusal at the metadata document", async () => {
    for (const req of [request(), withToken("garbage")]) {
      const header = (
        await authenticate(req, OAUTH, () => NOW_MS)
      ).refusal?.headers.get("WWW-Authenticate");
      expect(header).toContain(
        'resource_metadata="https://box.tail1234.ts.net/.well-known/oauth-protected-resource/mcp"',
      );
      expect(header).toContain('scope="espresso:read espresso:write"');
    }
  });

  it("refuses a credential that is not one of its own access tokens", async () => {
    // A bearer credential that is not one of this server's tokens fails
    // verification like any other bad token — there is no shared-secret path
    // to fall into.
    const outcome = await authenticate(
      request({ authorization: "Bearer correct-horse-battery-staple" }),
      OAUTH,
      () => NOW_MS,
    );
    expect(outcome.refusal?.status).toBe(401);
    expect(outcome.grant).toEqual({ mode: "oauth", scopes: [] });
  });

  it("grants every scope when nothing is configured", async () => {
    // Not a hole: the write tools are refused by `writeToolDisabled` with text
    // that explains there is no way to authenticate. A 403 here would point at
    // an authorization server that does not exist.
    expect((await authenticate(request(), OPEN)).grant).toEqual({
      mode: "none",
      scopes: ["espresso:read", "espresso:write"],
    });
  });

  it("ignores an Authorization header when nothing is configured", async () => {
    // An unconfigured server has nothing to check a credential against, so a
    // presented one is neither honoured nor a reason to refuse.
    expect(
      (await authenticate(request({ authorization: "Bearer anything" }), OPEN))
        .grant,
    ).toEqual({ mode: "none", scopes: ["espresso:read", "espresso:write"] });
  });

  it("defaults its clock to the real one", async () => {
    expect(
      (await authenticate(withToken(accessToken()), OAUTH)).refusal?.status,
    ).toBe(401);
  });
});

describe("checkRequest — OAuth", () => {
  it("still checks Origin before the credential", async () => {
    // Otherwise the 401/403 split tells an unauthenticated cross-origin prober
    // whether authentication is configured at all.
    const config = { ...OAUTH, allowedOrigins: ["https://claude.ai"] };
    expect(
      (await checkRequest(request({ origin: "https://evil.test" }), config))
        ?.status,
    ).toBe(403);
  });

  it("refuses an unauthenticated request with a discoverable 401", async () => {
    const response = await checkRequest(request(), OAUTH);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("accepts a precomputed authentication rather than redoing it", async () => {
    const req = request({ authorization: `Bearer ${accessToken()}` });
    const auth = await authenticate(req, OAUTH, () => NOW_MS);
    expect(await checkRequest(req, OAUTH, auth)).toBeUndefined();
  });
});

describe("loadSecurityConfig — an external issuer", () => {
  const DELEGATED = {
    MCP_OAUTH_ISSUER: TEST_EXTERNAL_ISSUER,
    MCP_PUBLIC_URL: ISSUER,
  };

  it("advertises the IdP as the issuer while still answering as the resource", async () => {
    // The split the whole feature turns on: `issuer` is who mints tokens,
    // `publicOrigin` is this server. With the built-in AS they are equal; here
    // they must not be, or protected-resource metadata would point Claude at
    // this server for an authorization endpoint it no longer serves.
    const oauth = loadSecurityConfig(DELEGATED).oauth;
    expect(oauth?.issuer).toBe(TEST_EXTERNAL_ISSUER);
    expect(oauth?.publicOrigin).toBe(ISSUER);
    expect(oauth?.resource).toBe(RESOURCE);
    expect(oauth?.external).toBeDefined();
    // Nothing is signed here, so neither credential is carried.
    expect(oauth?.secret).toBeUndefined();
    expect(oauth?.passphraseHash).toBeUndefined();
  });

  it("still requires a public URL, because that is what the audience is", async () => {
    expect(() =>
      loadSecurityConfig({ MCP_OAUTH_ISSUER: TEST_EXTERNAL_ISSUER }),
    ).toThrow(/MCP_PUBLIC_URL/);
  });

  it("refuses the credentials of the mode it is replacing", async () => {
    // Refused rather than ignored. Both belong to the built-in authorization
    // server, which does not mount here — so a deployment that set them holds a
    // belief about this server that is not true, and silently dropping them is
    // exactly how that belief survives to the day it matters.
    for (const extra of [
      { MCP_OAUTH_SECRET: SECRET },
      { MCP_OAUTH_PASSPHRASE_HASH: TEST_PASSPHRASE_HASH },
    ]) {
      expect(() => loadSecurityConfig({ ...DELEGATED, ...extra })).toThrow(
        ConfigError,
      );
    }
  });

  it("rejects an issuer that is not https", async () => {
    // It decides which public keys authenticate every request; over plain HTTP
    // anyone on the path substitutes their own JWKS.
    expect(() =>
      loadSecurityConfig({
        ...DELEGATED,
        MCP_OAUTH_ISSUER: "http://idp.example.test",
      }),
    ).toThrow(/https/);
  });

  it("verifies against the issuer's keys rather than a local secret", async () => {
    // The end-to-end shape, with discovery stubbed: a token this server could
    // not possibly have signed is accepted because the IdP vouches for it.
    const config = loadSecurityConfig(DELEGATED, {
      fetchImpl: (() =>
        Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
    });
    // A well-formed RS256 header, so verification gets past decoding and
    // reaches the key lookup — which is the step that only exists on the
    // external path.
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }),
    ).toString("base64url");
    const outcome = await authenticate(
      request({ authorization: `Bearer ${header}.e30.c2ln` }),
      { ...OPEN, oauth: config.oauth },
      () => NOW_MS,
    );
    // Unreachable IdP, so the verdict is a refusal — but `unknown-key` is a
    // reason only `externalIssuer` produces. The local HS256 path has no
    // concept of fetching a key, and would have said `bad-signature`.
    expect(outcome.reason).toBe("unknown-key");
    expect(outcome.refusal?.status).toBe(401);
  });

  it("points the 401 at this server's metadata, not the IdP's", async () => {
    // The pointer names where *this* server publishes protected-resource
    // metadata. Sending a client to the IdP for it breaks the exact discovery
    // path the header exists to fix.
    const config = loadSecurityConfig(DELEGATED);
    const outcome = await authenticate(request(), { ...OPEN, ...config });
    const challenge = outcome.refusal?.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(
      `${ISSUER}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(challenge).not.toContain(TEST_EXTERNAL_ISSUER);
  });
});

describe("describeSecurity", () => {
  function report(config: SecurityConfig, event: string) {
    return describeSecurity(config).find((entry) => entry.event === event);
  }

  it("warns at warn level when the endpoint is unauthenticated", async () => {
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

  it("says the removed shared secret is not an alternative", async () => {
    // Older advice offered MCP_AUTH_TOKEN; anyone following it writes a
    // variable that stops the server booting, so the warning names the removal.
    const message = String(
      report(OPEN, "security.unauthenticated")?.fields.message,
    );
    expect(message).toContain("MCP_AUTH_TOKEN was removed");
  });

  it("reports the gate instead of warning once OAuth is set", async () => {
    expect(report(OAUTH, "security.unauthenticated")).toBeUndefined();
    expect(report(OAUTH, "security.auth")?.fields.mode).toBe("oauth");
  });

  it("prints the advertised resource verbatim under OAuth", async () => {
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

  it("warns about the wildcard, the one unsafe origin setting", async () => {
    const entry = report(
      { ...OAUTH, allowedOrigins: ["*"] },
      "security.origins",
    );
    expect(entry?.level).toBe("warn");
    expect(entry?.fields.allowed).toBe("*");
  });

  it("lists the configured origins so they can be read back", async () => {
    const entry = report(
      { ...OAUTH, allowedOrigins: ["https://claude.ai", "https://a.test"] },
      "security.origins",
    );
    expect(entry?.level).toBe("info");
    expect(String(entry?.fields.message)).toContain(
      "https://claude.ai, https://a.test",
    );
  });

  it("explains the empty allowlist rather than looking like a misconfiguration", async () => {
    const entry = report(OAUTH, "security.origins");
    expect(entry?.level).toBe("info");
    expect(String(entry?.fields.message)).toContain("without an Origin header");
  });

  it("mentions the host allowlist only when one is configured", async () => {
    expect(report(OPEN, "security.hosts")).toBeUndefined();
    expect(
      report({ ...OPEN, allowedHosts: ["a.test"] }, "security.hosts")?.fields
        .allowed,
    ).toEqual(["a.test"]);
  });
});
