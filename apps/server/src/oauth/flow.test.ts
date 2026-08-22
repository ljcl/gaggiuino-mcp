import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler, type FetchHandler } from "../http";
import { setLogLevel } from "../logging";
import { type SecurityConfig } from "../mcpAuth";
import {
  delegatedConfig,
  TEST_EXTERNAL_ISSUER,
  TEST_ISSUER,
  TEST_OAUTH_CONFIG,
  TEST_PASSPHRASE,
  TEST_RESOURCE,
} from "./__fixtures__";
import { type ClientMetadata } from "./clients";
import { signToken } from "./tokens";

/**
 * The whole authorization flow, driven through the real fetch handler.
 *
 * This is the test that matters: every module below it can be individually
 * correct while the flow still fails, and the flow is the thing that either
 * works against a real connector or does not. It runs discovery, consent, the
 * code exchange, a call to `/mcp` with the resulting token, and a refresh.
 *
 * CIMD resolution is injected rather than fetched — `test-setup.ts` runs msw
 * with `onUnhandledRequest: "error"`, and a test suite that reaches claude.ai
 * is a test suite that fails when the network does.
 */

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const CLAUDE: ClientMetadata = {
  clientId: CLIENT_ID,
  clientName: "Claude",
  redirectUris: [REDIRECT_URI],
};

const LOOPBACK: ClientMetadata = {
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  clientName: "Claude Code",
  redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
};

const OAUTH: SecurityConfig = {
  allowedHosts: [],
  allowedOrigins: [],
  oauth: TEST_OAUTH_CONFIG,
};

/**
 * An external issuer that refuses everything. These two tests exercise routing
 * and metadata, never verification — a real `createExternalIssuer` would put
 * discovery on the path of a test about which URLs are mounted.
 */
const NEVER_VERIFIES = {
  verify: () =>
    Promise.resolve({ ok: false as const, reason: "unknown-key" as const }),
};

let handler: FetchHandler;

/** The clients this handler will resolve, by id. */
function clientsFor(...known: ClientMetadata[]) {
  const table = new Map(known.map((client) => [client.clientId, client]));
  return (clientId: string) => Promise.resolve(table.get(clientId));
}

beforeEach(() => {
  handler = createFetchHandler({
    resolveClient: clientsFor(CLAUDE, LOOPBACK),
    security: OAUTH,
  });
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    verifier,
  };
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${TEST_ISSUER}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A well-formed authorization request for the hosted Claude client. */
function authorizeParams(challenge: string): Record<string, string> {
  return {
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: TEST_RESOURCE,
    response_type: "code",
    scope: "espresso:read espresso:write offline_access",
    state: "opaque-state",
  };
}

/** Pull the one-time CSRF token out of the rendered consent page. */
function requestTokenFrom(html: string): string {
  const match = /name="request_token" value="([^"]+)"/.exec(html);
  expect(match?.[1], "consent page carries a request_token").toBeTruthy();
  return match?.[1] ?? "";
}

function consentPost(
  requestToken: string,
  passphrase: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${TEST_ISSUER}/oauth/authorize`, {
    body: new URLSearchParams({
      passphrase,
      request_token: requestToken,
    }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    method: "POST",
  });
}

/**
 * A POST whose body stream fails part-way.
 *
 * What a dropped upload looks like from inside the handler. Unguarded, the
 * `await req.text()` rejects out of `fetch` as an unhandled rejection rather
 * than an HTTP status.
 */
function brokenBodyRequest(path: string): Request {
  return new Request(`${TEST_ISSUER}${path}`, {
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    // Required whenever the body is a stream.
    duplex: "half",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

function tokenPost(body: Record<string, string>): Request {
  return new Request(`${TEST_ISSUER}/oauth/token`, {
    body: new URLSearchParams(body).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

/** Run consent to completion and return the authorization code. */
async function grantCode(
  challenge: string,
  overrides: Record<string, string> = {},
): Promise<string> {
  const page = await handler.fetch(
    new Request(authorizeUrl({ ...authorizeParams(challenge), ...overrides })),
  );
  const token = requestTokenFrom(await page.text());
  const redirect = await handler.fetch(consentPost(token, TEST_PASSPHRASE));
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get("Location") ?? "");
  return location.searchParams.get("code") ?? "";
}

describe("discovery", () => {
  it("advertises the two things that make Claude choose CIMD", async () => {
    // Claude requires BOTH the flag and "none" before it will use a client_id
    // URL. If either is missing it goes looking for a registration_endpoint
    // this server deliberately does not have, and the connection fails.
    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/.well-known/oauth-authorization-server`),
    );
    expect(response.status).toBe(200);
    const doc = (await response.json()) as Record<string, unknown>;
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("advertises S256 and offline_access", async () => {
    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/.well-known/oauth-authorization-server`),
    );
    const doc = (await response.json()) as Record<string, unknown>;
    // Claude sends code_challenge_method=S256 on every authorization request,
    // and the spec says a client MUST refuse to proceed if this is absent.
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    // Claude appends offline_access only when the metadata lists it. Without a
    // refresh token the owner re-consents constantly on iOS.
    expect(doc.scopes_supported).toContain("offline_access");
  });

  it("unmounts the authorization server entirely for an external issuer", async () => {
    // Resource-server-only mode. Serving an authorization endpoint while
    // advertising somebody else's would give a client two answers to the same
    // question, so these must be gone rather than merely unadvertised.
    const delegated = createFetchHandler({
      security: {
        allowedHosts: [],
        allowedOrigins: [],
        oauth: delegatedConfig(NEVER_VERIFIES),
      },
    });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
      "/oauth/token",
    ]) {
      const response = await delegated.fetch(
        new Request(`${TEST_ISSUER}${path}`),
      );
      expect(response.status, path).toBe(404);
    }
    await delegated.shutdown();
  });

  it("points protected-resource metadata at the external issuer", async () => {
    // The one document this server still publishes in that mode, and the only
    // thing that tells Claude where to go instead.
    const delegated = createFetchHandler({
      security: {
        allowedHosts: [],
        allowedOrigins: [],
        oauth: delegatedConfig(NEVER_VERIFIES),
      },
    });
    const response = await delegated.fetch(
      new Request(`${TEST_ISSUER}/.well-known/oauth-protected-resource`),
    );
    expect(response.status).toBe(200);
    const doc = (await response.json()) as Record<string, unknown>;
    expect(doc.authorization_servers).toEqual([TEST_EXTERNAL_ISSUER]);
    // Still this server's own resource: the IdP mints the token, this server is
    // what the token is *for*.
    expect(doc.resource).toBe(TEST_RESOURCE);
    await delegated.shutdown();
  });

  it("keeps the authorization server off an unconfigured deployment", async () => {
    const open = createFetchHandler({
      security: { allowedHosts: [], allowedOrigins: [] },
    });
    const response = await open.fetch(
      new Request(`${TEST_ISSUER}/.well-known/oauth-authorization-server`),
    );
    expect(response.status).toBe(404);
    await open.shutdown();
  });
});

describe("/oauth/authorize", () => {
  it("renders a consent page naming the client's host", async () => {
    const response = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // Never framed: a clickjacked "Allow access" defeats the passphrase.
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain("claude.ai");
    // Plain language, not the raw scope strings — the person reading this is
    // deciding whether to hand over their machine, not auditing an OAuth flow.
    expect(html).toContain("Read your shot history");
    expect(html).toContain("Change your machine");
  });

  it("refuses a request with nowhere safe to send the user back to", async () => {
    for (const missing of ["client_id", "redirect_uri"]) {
      const params = { ...authorizeParams(pkce().challenge) } as Record<
        string,
        string
      >;
      delete params[missing];
      const response = await handler.fetch(new Request(authorizeUrl(params)));
      expect(response.status, missing).toBe(400);
      expect(response.headers.get("Location"), missing).toBeNull();
    }
  });

  it("refuses an unverifiable client without redirecting anywhere", async () => {
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          client_id: "https://stranger.test/meta",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("refuses a redirect_uri the client never declared", async () => {
    // The open redirect this validation exists to prevent: a stolen code is
    // only useful if it can be delivered somewhere the attacker controls.
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          redirect_uri: "https://evil.test/steal",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("reports a bad request_type back to a verified redirect_uri", async () => {
    // Once redirect_uri is established, errors are the client's to handle.
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          response_type: "token",
        }),
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
    expect(location.searchParams.get("state")).toBe("opaque-state");
  });

  it("requires PKCE", async () => {
    const { code_challenge: _dropped, ...withoutPkce } = authorizeParams("x");
    const response = await handler.fetch(
      new Request(authorizeUrl(withoutPkce)),
    );
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("Location") ?? "").searchParams.get("error"),
    ).toBe("invalid_request");
  });

  it("never emits the RFC 9207 iss parameter", async () => {
    // A self-hosted server correlated adding it with Anthropic's backend
    // ceasing to call /token at all. Not worth testing on a real connector.
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          response_type: "token",
        }),
      ),
    );
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("iss")).toBeNull();
  });

  it("warns when every redirect address is on this computer", async () => {
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          client_id: LOOPBACK.clientId,
          redirect_uri: "http://127.0.0.1:54321/callback",
        }),
      ),
    );
    expect(response.status).toBe(200);
    // Any local process can bind a port and claim to be the client.
    expect(await response.text()).toContain("Any program running locally");
  });

  it("ignores the port on a loopback redirect", async () => {
    // Claude Code declares http://localhost/callback and then binds an
    // ephemeral port, so an exact match would reject every real attempt.
    const response = await handler.fetch(
      new Request(
        authorizeUrl({
          ...authorizeParams(pkce().challenge),
          client_id: LOOPBACK.clientId,
          redirect_uri: "http://localhost:61234/callback",
        }),
      ),
    );
    expect(response.status).toBe(200);
  });
});

describe("consent", () => {
  it("mints a code and preserves state on the right passphrase", async () => {
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const requestToken = requestTokenFrom(await page.text());

    const response = await handler.fetch(
      consentPost(requestToken, TEST_PASSPHRASE),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("opaque-state");
  });

  it("re-renders with a fresh token on the wrong passphrase", async () => {
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const first = requestTokenFrom(await page.text());

    const response = await handler.fetch(consentPost(first, "wrong"));
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("not correct");
    // The retry page mints its own token rather than echoing the submitted one,
    // so the page the owner is looking at is indistinguishable from a first
    // render.
    const second = requestTokenFrom(html);
    expect(second).not.toBe(first);

    const retry = await handler.fetch(consentPost(second, TEST_PASSPHRASE));
    expect(retry.status).toBe(302);
  });

  it("survives a flood of consent pages from an unauthenticated caller", async () => {
    // The consent token is signed and stateless, so a flood of unauthenticated
    // GETs has nothing to evict — the owner's open page cannot expire out from
    // under them.
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const owner = requestTokenFrom(await page.text());

    for (let flood = 0; flood < 65; flood += 1) {
      const response = await handler.fetch(
        new Request(authorizeUrl(authorizeParams(pkce().challenge))),
      );
      expect(response.status, `flood ${flood}`).toBe(200);
    }

    expect(
      (await handler.fetch(consentPost(owner, TEST_PASSPHRASE))).status,
    ).toBe(302);
  });

  it("accepts a replayed request token, and still spends the code once", async () => {
    // The stated cost of statelessness: a consent token is not single-use,
    // so a captured submission can be replayed inside its TTL. Acceptable
    // because the token carries no authority on its own — a submission an
    // attacker captured contains the passphrase, so single-use never protected
    // against the one attacker it looked like it did. What a replay yields is a
    // *fresh* code, and the code is where single-use actually lives.
    const { challenge, verifier } = pkce();
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(challenge))),
    );
    const requestToken = requestTokenFrom(await page.text());

    const codes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handler.fetch(
        consentPost(requestToken, TEST_PASSPHRASE),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "");
      codes.push(location.searchParams.get("code") ?? "");
    }
    expect(codes[0]).not.toBe(codes[1]);

    const exchange = (code: string) =>
      handler.fetch(
        tokenPost({
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
        }),
      );
    expect((await exchange(codes[1] as string)).status).toBe(200);
    expect((await exchange(codes[1] as string)).status).toBe(400);
  });

  it("refuses a consent token as an authorization code", async () => {
    // Same secret, different HKDF `info`. A consent token is handed to a browser
    // before any passphrase is checked, so redeeming one here would skip consent
    // entirely.
    const { challenge, verifier } = pkce();
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(challenge))),
    );
    const requestToken = requestTokenFrom(await page.text());

    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code: requestToken,
        code_verifier: verifier,
        grant_type: "authorization_code",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("refuses a form submitted from another site", async () => {
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const requestToken = requestTokenFrom(await page.text());
    const response = await handler.fetch(
      consentPost(requestToken, TEST_PASSPHRASE, {
        origin: "https://evil.test",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("accepts the form from its own origin", async () => {
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const requestToken = requestTokenFrom(await page.text());
    const response = await handler.fetch(
      consentPost(requestToken, TEST_PASSPHRASE, { origin: TEST_ISSUER }),
    );
    expect(response.status).toBe(302);
  });

  it("refuses a GET-less POST with no pending request", async () => {
    const response = await handler.fetch(
      consentPost("never-issued", TEST_PASSPHRASE),
    );
    expect(response.status).toBe(400);
  });

  it("stops answering after enough wrong passphrases", async () => {
    // The default is ten attempts per fifteen minutes. Each one costs ~36 ms of
    // scrypt, so this bounds the CPU an unauthenticated caller can spend as
    // much as it bounds the guessing.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const page = await handler.fetch(
        new Request(authorizeUrl(authorizeParams(pkce().challenge))),
      );
      const requestToken = requestTokenFrom(await page.text());
      const response = await handler.fetch(consentPost(requestToken, "wrong"));
      statuses.push(response.status);
    }
    // Ten refusals, then the door closes — not one early, which would lock the
    // owner out sooner than the documented limit.
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it("forgets the failures once a passphrase succeeds", async () => {
    // A typo must not leave the owner part-way to a lockout.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const page = await handler.fetch(
        new Request(authorizeUrl(authorizeParams(pkce().challenge))),
      );
      await handler.fetch(
        consentPost(requestTokenFrom(await page.text()), "wrong"),
      );
    }
    const page = await handler.fetch(
      new Request(authorizeUrl(authorizeParams(pkce().challenge))),
    );
    const ok = await handler.fetch(
      consentPost(requestTokenFrom(await page.text()), TEST_PASSPHRASE),
    );
    expect(ok.status).toBe(302);

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const retry = await handler.fetch(
        new Request(authorizeUrl(authorizeParams(pkce().challenge))),
      );
      const response = await handler.fetch(
        consentPost(requestTokenFrom(await retry.text()), "wrong"),
      );
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
  });

  it("answers a method that is neither GET nor POST with 405", async () => {
    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/oauth/authorize`, { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("POST");
  });

  it("refuses a body it cannot read rather than rejecting out of the handler", async () => {
    const response = await handler.fetch(brokenBodyRequest("/oauth/authorize"));
    expect(response.status).toBe(400);
  });
});

describe("/oauth/token", () => {
  it("exchanges a code for an access and refresh token", async () => {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);

    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.scope).toBe("espresso:read espresso:write");
  });

  it("reads a form body, not JSON", async () => {
    // The documented tripwire: a JSON-only body parser answers 415 here and
    // the whole flow dies at the last step.
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);
    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/oauth/token`, {
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    const code = await grantCode(pkce().challenge);
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code,
        code_verifier: pkce().verifier,
        grant_type: "authorization_code",
      }),
    );
    expect(response.status).toBe(400);
    // The exact code matters: Claude's refresh handling keys on invalid_grant,
    // and a custom code or invalid_request breaks it.
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("records a refused exchange, not only a successful one", async () => {
    // The gap this closes: a connector that consents and then never connects
    // leaves `oauth.authorized` with nothing after it, and the log could not
    // say whether the code was presented and refused or never presented at
    // all. Those are opposite diagnoses — one is this server, one is not.
    // Captures the real sink so the default `console.error` path stays in the
    // loop, as the tool-call logging tests do.
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    setLogLevel("warn");
    try {
      const code = await grantCode(pkce().challenge);
      await handler.fetch(
        tokenPost({
          client_id: CLIENT_ID,
          code,
          code_verifier: pkce().verifier,
          grant_type: "authorization_code",
        }),
      );
    } finally {
      spy.mockRestore();
      setLogLevel("silent");
    }
    expect(
      records.find((entry) => entry.event === "oauth.token_denied"),
    ).toMatchObject({
      clientId: CLIENT_ID,
      error: "invalid_grant",
      grant: "authorization_code",
      reason: "The PKCE verifier does not match",
    });
  });

  it("spends a code exactly once", async () => {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);
    const exchange = () =>
      handler.fetch(
        tokenPost({
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
        }),
      );
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
  });

  it("refuses a code redeemed by a different client", async () => {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);
    const response = await handler.fetch(
      tokenPost({
        client_id: LOOPBACK.clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a code redeemed against a different redirect_uri", async () => {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://evil.test/steal",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("names an unsupported grant rather than failing opaquely", async () => {
    const response = await handler.fetch(tokenPost({ grant_type: "password" }));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "unsupported_grant_type",
    });
  });

  it("answers anything but POST with 405", async () => {
    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/oauth/token`),
    );
    expect(response.status).toBe(405);
  });

  it("requires a code_verifier, and says which field is missing", async () => {
    const code = await grantCode(pkce().challenge);
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code,
        grant_type: "authorization_code",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "invalid_request",
    });
  });

  it("refuses a body it cannot read rather than rejecting out of the handler", async () => {
    const response = await handler.fetch(brokenBodyRequest("/oauth/token"));
    expect(response.status).toBe(400);
  });
});

describe("refresh", () => {
  /** A complete authorization, for whichever client the test needs one from. */
  async function firstTokens(
    client: ClientMetadata = CLAUDE,
    redirectUri: string = REDIRECT_URI,
  ): Promise<Record<string, string>> {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge, {
      client_id: client.clientId,
      redirect_uri: redirectUri,
    });
    const response = await handler.fetch(
      tokenPost({
        client_id: client.clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
      }),
    );
    return (await response.json()) as Record<string, string>;
  }

  /** Present a refresh token, optionally claiming to be somebody else. */
  function refresh(
    refreshToken: string,
    clientId: string | undefined = CLIENT_ID,
  ): Promise<Response> {
    return handler.fetch(
      tokenPost({
        ...(clientId === undefined ? {} : { client_id: clientId }),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
  }

  it("rotates the refresh token in the same response", async () => {
    const first = await firstTokens();
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token ?? "",
      }),
    );
    expect(response.status).toBe(200);
    const second = (await response.json()) as Record<string, string>;
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
  });

  it("detects a superseded refresh token being replayed", async () => {
    const first = await firstTokens();
    const rotated = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token ?? "",
      }),
    );
    expect(rotated.status).toBe(200);

    const replayed = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token ?? "",
      }),
    );
    expect(replayed.status).toBe(400);
    expect((await replayed.json()) as { error: string }).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("refuses a refresh token that is not a token at all", async () => {
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("keeps each client's rotation independent", async () => {
    // The generation counter is keyed by client. Sharing one counter would let
    // a second client's refresh invalidate the first client's token.
    //
    // Two genuine authorizations, which is the only way to state that.
    const claude = await firstTokens();
    const codeClient = await firstTokens(
      LOOPBACK,
      "http://localhost:61234/callback",
    );

    expect((await refresh(claude.refresh_token ?? "")).status).toBe(200);
    const other = await refresh(
      codeClient.refresh_token ?? "",
      LOOPBACK.clientId,
    );
    expect(other.status).toBe(200);
  });

  it("refuses a refresh token presented under another client's id", async () => {
    // Replay detection keys on the client sealed into the token, not this
    // caller-supplied field — naming another client cannot land a stolen token
    // on a fresh counter.
    const first = await firstTokens();
    const response = await refresh(
      first.refresh_token ?? "",
      LOOPBACK.clientId,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("accepts a refresh that omits client_id, since the token carries it", async () => {
    // Present-but-wrong is a refusal; absent is fine. Requiring the field would
    // break a client that reasonably leaves out what its token already states.
    const first = await firstTokens();
    expect((await refresh(first.refresh_token ?? "", undefined)).status).toBe(
      200,
    );
  });

  it("refuses a refresh token minted before the client was sealed into it", async () => {
    // Tokens minted before the client was sealed into them carry no `cid`;
    // falling back to the form field would leave the bypass open for their
    // whole ninety-day life — and let an attacker choose that path by
    // presenting an old token. `invalid_grant` is what Claude re-runs the
    // authorization flow on, so this is one consent prompt, once.
    const seconds = Math.floor(Date.now() / 1000);
    const legacy = signToken(
      {
        aud: TEST_RESOURCE,
        exp: seconds + 3600,
        gen: 1,
        iat: seconds,
        iss: TEST_ISSUER,
        jti: "legacy",
        scope: "espresso:read espresso:write",
        sub: "owner",
      },
      TEST_OAUTH_CONFIG.secret,
      "refresh-token",
    );
    const response = await refresh(legacy);
    expect(response.status).toBe(400);
    expect(
      (await response.json()) as { error: string; error_description: string },
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("keeps a re-authorized connector working across its first refresh", async () => {
    // A fresh authorization must outrank every generation issued before it, or
    // a re-connected connector authenticates once and dies on its first
    // refresh as `oauth.refresh_replayed`.
    const first = await firstTokens();
    const rotated = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token ?? "",
      }),
    );
    expect(rotated.status).toBe(200);

    const reauthorized = await firstTokens();
    const refreshed = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: reauthorized.refresh_token ?? "",
      }),
    );
    expect(refreshed.status).toBe(200);
  });

  it("refuses an access token presented as a refresh token", async () => {
    // The HKDF `info` split: same secret, different derived key.
    const first = await firstTokens();
    const response = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: first.access_token ?? "",
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("the token the flow produced", () => {
  it("is accepted by /mcp, which the flow exists to reach", async () => {
    const { challenge, verifier } = pkce();
    const code = await grantCode(challenge);
    const exchanged = await handler.fetch(
      tokenPost({
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
      }),
    );
    const { access_token: accessToken } = (await exchanged.json()) as {
      access_token: string;
    };

    const response = await handler.fetch(
      new Request(`${TEST_ISSUER}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
            protocolVersion: "2025-06-18",
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    // Stateless serving mints no session id; the 200 on the handshake is the
    // proof the token cleared the gate.
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});
