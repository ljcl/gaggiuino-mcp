import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createExternalIssuer,
  discoveryUrls,
  type ExternalIssuerOptions,
} from "./externalIssuer";

/**
 * Verification against an external authorization server.
 *
 * Tokens are signed with **real** keys generated here rather than pinned
 * fixtures, and `fetchImpl` is injected rather than intercepted — `test-setup.ts`
 * runs msw with `onUnhandledRequest: "error"`, and a suite that reaches a real
 * IdP is a suite that fails when the network does.
 *
 * Signing for real is what makes the negative cases mean anything: a hand-built
 * "bad signature" fixture proves only that a constant does not match, while
 * these are genuine signatures that fail for the reason each test names.
 */

const ISSUER = "https://idp.example.test/realms/home";
const RESOURCE = "https://box.tail1234.ts.net/mcp";
const JWKS_URI =
  "https://idp.example.test/realms/home/protocol/openid-connect/certs";
const NOW_MS = 1_000_000_000;

interface SigningKey {
  jwk: webcrypto.JsonWebKey & { kid?: string };
  privateKey: webcrypto.CryptoKey;
}

async function generate(
  alg: "ES256" | "RS256",
  kid: string,
): Promise<SigningKey> {
  const params =
    alg === "RS256"
      ? {
          hash: "SHA-256",
          modulusLength: 2048,
          name: "RSASSA-PKCS1-v1_5",
          publicExponent: new Uint8Array([1, 0, 1]),
        }
      : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await webcrypto.subtle.generateKey(params, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return { jwk: { ...jwk, alg, kid, use: "sig" }, privateKey: pair.privateKey };
}

let rsa: SigningKey;
let ec: SigningKey;

beforeAll(async () => {
  rsa = await generate("RS256", "rsa-1");
  ec = await generate("ES256", "ec-1");
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Claims a correctly configured IdP would mint for this server. */
function claims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aud: RESOURCE,
    exp: NOW_MS / 1000 + 3600,
    iat: NOW_MS / 1000,
    iss: ISSUER,
    scope: "espresso:read espresso:write",
    sub: "owner@example.test",
    ...overrides,
  };
}

async function sign(
  key: SigningKey,
  payload: Record<string, unknown> = claims(),
  header: Record<string, unknown> = {},
): Promise<string> {
  const alg = key.jwk.alg as "ES256" | "RS256";
  const head = b64url({ alg, kid: key.jwk.kid, typ: "JWT", ...header });
  const body = b64url(payload);
  const signature = await webcrypto.subtle.sign(
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { hash: "SHA-256", name: "ECDSA" },
    key.privateKey,
    Buffer.from(`${head}.${body}`, "utf8"),
  );
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

interface IdpOptions {
  /** Which discovery document the IdP serves. Both, by default. */
  serves?: ("oidc" | "rfc8414")[];
  /** Overrides merged into the discovery document. */
  metadata?: Record<string, unknown>;
  keys?: (webcrypto.JsonWebKey & { kid?: string })[];
}

/** A fake IdP that records every URL fetched. */
function idp(options: IdpOptions = {}) {
  const serves = options.serves ?? ["rfc8414", "oidc"];
  const calls: string[] = [];
  const state = { keys: options.keys ?? [] };
  const [rfc8414Url, oidcUrl] = discoveryUrls(ISSUER) as [string, string];

  const fetchImpl = ((url: string | URL) => {
    const href = String(url);
    calls.push(href);
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );

    if (href === rfc8414Url && serves.includes("rfc8414")) {
      return json({ issuer: ISSUER, jwks_uri: JWKS_URI, ...options.metadata });
    }
    if (href === oidcUrl && serves.includes("oidc")) {
      return json({ issuer: ISSUER, jwks_uri: JWKS_URI, ...options.metadata });
    }
    if (href === JWKS_URI) return json({ keys: state.keys });
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;

  return { calls, fetchImpl, state };
}

function verifier(
  fetchImpl: typeof fetch,
  options: ExternalIssuerOptions = {},
) {
  return createExternalIssuer(ISSUER, {
    fetchImpl,
    now: () => NOW_MS,
    ...options,
  });
}

const verifyOptions = { audience: RESOURCE, now: () => NOW_MS };

describe("discoveryUrls", () => {
  it("inserts the RFC 8414 segment before the path and appends the OIDC one", () => {
    // Not a suffix apart: RFC 8414 puts its well-known segment *before* the
    // issuer's path, OIDC after. Keycloak and Authentik issuers always carry a
    // path, so collapsing these two into one shape breaks both.
    expect(discoveryUrls("https://idp.example.test/realms/home")).toEqual([
      "https://idp.example.test/.well-known/oauth-authorization-server/realms/home",
      "https://idp.example.test/realms/home/.well-known/openid-configuration",
    ]);
  });

  it("collapses to the bare forms for a path-less issuer", () => {
    expect(discoveryUrls("https://idp.example.test")).toEqual([
      "https://idp.example.test/.well-known/oauth-authorization-server",
      "https://idp.example.test/.well-known/openid-configuration",
    ]);
  });
});

describe("verifying a token", () => {
  it("accepts an RS256 token from the configured issuer", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.claims).toEqual({
      scope: "espresso:read espresso:write",
      sub: "owner@example.test",
    });
  });

  it("accepts an ES256 token", async () => {
    const { fetchImpl } = idp({ keys: [ec.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(ec),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses a token signed by a key the issuer does not publish", async () => {
    // The signature is genuine — it is simply not the issuer's. This is the
    // whole point of fetching a key set rather than trusting the token.
    const stranger = await generate("RS256", "rsa-1");
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(stranger),
      verifyOptions,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });

  it("refuses a tampered payload", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const [head, , signature] = (await sign(rsa)).split(".");
    const escalated = b64url(claims({ scope: "espresso:read admin" }));
    const verdict = await verifier(fetchImpl).verify(
      `${head}.${escalated}.${signature}`,
      verifyOptions,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });
});

describe("the algorithm allowlist", () => {
  it("refuses HS256 even when the header names a real key", async () => {
    // The algorithm-confusion attack: an attacker takes the issuer's *public*
    // key — which is public by design — and uses it as an HMAC secret. Any
    // verifier that reads `alg` and then picks a matching operation accepts it.
    // This one never reaches a key lookup at all.
    const { fetchImpl, calls } = idp({ keys: [rsa.jwk] });
    const head = b64url({ alg: "HS256", kid: "rsa-1", typ: "JWT" });
    const body = b64url(claims());
    const forged = `${head}.${body}.${Buffer.from("whatever").toString("base64url")}`;

    const verdict = await verifier(fetchImpl).verify(forged, verifyOptions);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("unsupported-algorithm");
    // Refused before any network call, which is the structural part: the
    // allowlist is checked ahead of the key lookup, not alongside it.
    expect(calls).toEqual([]);
  });

  it('refuses alg "none"', async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const head = b64url({ alg: "none", typ: "JWT" });
    const verdict = await verifier(fetchImpl).verify(
      `${head}.${b64url(claims())}.`,
      verifyOptions,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("unsupported-algorithm");
  });

  it("refuses an algorithm it simply does not implement", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const head = b64url({ alg: "RS512", kid: "rsa-1", typ: "JWT" });
    const verdict = await verifier(fetchImpl).verify(
      `${head}.${b64url(claims())}.${Buffer.from("x").toString("base64url")}`,
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unsupported-algorithm");
  });
});

describe("claim checks", () => {
  it("refuses a token from a different issuer", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, claims({ iss: "https://other.example.test" })),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("wrong-issuer");
  });

  it("refuses an expired token", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const token = await sign(rsa, claims({ exp: NOW_MS / 1000 }));
    const verdict = await verifier(fetchImpl).verify(token, verifyOptions);
    expect(!verdict.ok && verdict.reason).toBe("expired");
  });

  it("refuses a token minted for another resource", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, claims({ aud: "https://someone-else.test/mcp" })),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("wrong-audience");
  });

  it("accepts an aud array containing this resource", async () => {
    // Every IdP that can address more than one resource emits the array form,
    // so reading only the string rejects correctly configured tokens.
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, claims({ aud: ["https://other.test/mcp", RESOURCE] })),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses an aud that is not a URL, without throwing", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, claims({ aud: "not-a-url" })),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("wrong-audience");
  });

  it("reads Entra's scp claim when scope is absent", async () => {
    // Reading only `scope` leaves an Entra deployment authenticated and holding
    // nothing, which presents as every write being refused with no explanation.
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims({ scp: ["espresso:read", "espresso:write"] });
    delete payload.scope;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(verdict.ok && verdict.claims.scope).toBe(
      "espresso:read espresso:write",
    );
  });

  it("refuses a token with no subject", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims();
    delete payload.sub;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });
});

describe("discovery", () => {
  it("falls back to openid-configuration when RFC 8414 is absent", async () => {
    // Most hosted providers serve only the OIDC document, so the fallback is
    // not optional.
    const { calls, fetchImpl } = idp({ keys: [rsa.jwk], serves: ["oidc"] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
    expect(calls[0]).toContain("/.well-known/oauth-authorization-server");
    expect(calls[1]).toContain("/.well-known/openid-configuration");
  });

  it("refuses a document whose issuer is not the configured one", async () => {
    // RFC 8414 §3.3. Without it, a redirect — or a typo landing on somebody
    // else's tenant — silently substitutes a different key set for the one this
    // server was told to trust.
    const { fetchImpl } = idp({
      keys: [rsa.jwk],
      metadata: { issuer: "https://attacker.test" },
    });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });

  it("refuses a document with no jwks_uri", async () => {
    const { fetchImpl } = idp({
      keys: [rsa.jwk],
      metadata: { jwks_uri: null },
    });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });

  it("answers unknown-key when the issuer cannot be reached at all", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });

  it("caches discovery and the key set across calls", async () => {
    // The IdP is a remote host on the critical path of every single request. A
    // verifier that rediscovered per call would put two round trips in front of
    // every tool call.
    const { calls, fetchImpl } = idp({ keys: [rsa.jwk] });
    const issuer = verifier(fetchImpl);
    const token = await sign(rsa);

    expect((await issuer.verify(token, verifyOptions)).ok).toBe(true);
    const afterFirst = calls.length;
    expect((await issuer.verify(token, verifyOptions)).ok).toBe(true);
    expect((await issuer.verify(token, verifyOptions)).ok).toBe(true);
    expect(calls.length).toBe(afterFirst);
  });
});

describe("key rotation", () => {
  it("refetches the key set for an unrecognised kid", async () => {
    // Rotation has to work without a restart: the IdP starts signing with a new
    // key, and the first token naming it is what tells this server to look.
    const clock = { ms: NOW_MS };
    const { calls, fetchImpl, state } = idp({ keys: [rsa.jwk] });
    const issuer = verifier(fetchImpl, { now: () => clock.ms });

    expect((await issuer.verify(await sign(rsa), verifyOptions)).ok).toBe(true);

    const rotated = await generate("RS256", "rsa-2");
    state.keys = [rsa.jwk, rotated.jwk];
    // Past the cooldown, which is the only thing standing between rotation
    // working and the refetch being a remote-fetch trigger.
    clock.ms += 61_000;

    const before = calls.length;
    const verdict = await issuer.verify(await sign(rotated), verifyOptions);
    expect(verdict.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(before);
  });

  it("throttles refetching so an unknown kid is not a remote-fetch trigger", async () => {
    // Unauthenticated callers reach this: a token is checked before anything
    // knows whether it is real. Without the cooldown, tokens carrying random
    // kids would each drive a request to the IdP.
    const { calls, fetchImpl } = idp({ keys: [rsa.jwk] });
    const issuer = verifier(fetchImpl);
    expect((await issuer.verify(await sign(rsa), verifyOptions)).ok).toBe(true);

    const settled = calls.length;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stranger = await generate("RS256", `made-up-${attempt}`);
      const verdict = await issuer.verify(await sign(stranger), verifyOptions);
      expect(!verdict.ok && verdict.reason).toBe("unknown-key");
    }
    expect(calls.length).toBe(settled);
  });
});

describe("key selection", () => {
  it("ignores encryption keys sharing a kid with a signing key", async () => {
    // A JWKS routinely carries both, and an IdP may reuse a kid across them.
    // Matching the wrong one presents as an intermittent failure that depends
    // on the order the IdP listed its keys in.
    const { fetchImpl } = idp({
      keys: [{ ...rsa.jwk, use: "enc" }, rsa.jwk],
    });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
  });

  it("uses the only signing key when a token carries no kid", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, claims(), { kid: undefined }),
      verifyOptions,
    );
    expect(verdict.ok).toBe(true);
  });

  it("answers unknown-key for a JWK WebCrypto will not import", async () => {
    const { fetchImpl } = idp({
      keys: [{ alg: "RS256", kid: "rsa-1", kty: "RSA", n: "!!!not-base64!!!" }],
    });
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });
});

describe("malformed input", () => {
  it("refuses anything that is not three segments", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const issuer = verifier(fetchImpl);
    for (const malformed of ["", "a", "a.b", "a.b.c.d"]) {
      const verdict = await issuer.verify(malformed, verifyOptions);
      expect(!verdict.ok && verdict.reason, malformed).toBe("malformed");
    }
  });

  it("refuses a header that is not JSON", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const verdict = await verifier(fetchImpl).verify(
      "aaa.bbb.ccc",
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("refuses a correctly signed payload that is not JSON", async () => {
    // Signed with the real key, so it gets *past* the signature check and fails
    // on decode — the branch that would otherwise throw out of the handler.
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const head = b64url({ alg: "RS256", kid: "rsa-1", typ: "JWT" });
    const body = Buffer.from("not json at all").toString("base64url");
    const signature = await webcrypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      rsa.privateKey,
      Buffer.from(`${head}.${body}`, "utf8"),
    );
    const verdict = await verifier(fetchImpl).verify(
      `${head}.${body}.${Buffer.from(signature).toString("base64url")}`,
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("refuses a token with no exp", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims();
    delete payload.exp;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("refuses a JWKS that is not an array of keys", async () => {
    const fetchImpl = ((url: string | URL) => {
      const href = String(url);
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      if (href === JWKS_URI) return json({ keys: "nope" });
      return json({ issuer: ISSUER, jwks_uri: JWKS_URI });
    }) as unknown as typeof fetch;

    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });

  it("refuses a document larger than the cap", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("x".repeat(600 * 1024), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )) as unknown as typeof fetch;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
  });

  it("refuses a header that is JSON but not an object", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const issuer = verifier(fetchImpl);
    for (const head of [b64url(123), b64url(null), b64url("a string")]) {
      const verdict = await issuer.verify(`${head}.e30.c2ln`, verifyOptions);
      expect(!verdict.ok && verdict.reason, head).toBe("malformed");
    }
  });

  it("refuses a token with no audience at all", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims();
    delete payload.aud;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(!verdict.ok && verdict.reason).toBe("wrong-audience");
  });
});

describe("scope normalisation", () => {
  it("reads a space-delimited scp string", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims({ scp: "espresso:read espresso:write" });
    delete payload.scope;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(verdict.ok && verdict.claims.scope).toBe(
      "espresso:read espresso:write",
    );
  });

  it("grants nothing when the token carries no scope claim", async () => {
    // Authenticated but holding nothing, which is the honest reading: the write
    // tools are then refused by the scope gate rather than silently allowed.
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const payload = claims();
    delete payload.scope;
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa, payload),
      verifyOptions,
    );
    expect(verdict.ok && verdict.claims.scope).toBe("");
  });
});

describe("an IdP behaving badly", () => {
  /** A fetch that answers every URL the same way. */
  function always(make: () => Promise<Response>): typeof fetch {
    return (() => make()) as unknown as typeof fetch;
  }

  async function reason(fetchImpl: typeof fetch) {
    const verdict = await verifier(fetchImpl).verify(
      await sign(rsa),
      verifyOptions,
    );
    return verdict.ok ? "ok" : verdict.reason;
  }

  it("survives a rejection that is not an Error", async () => {
    // `String(error)` rather than `error.message`: a DNS layer that rejects with
    // a string would otherwise put `undefined` in the operator's log.
    expect(
      await reason((() => Promise.reject("boom")) as unknown as typeof fetch),
    ).toBe("unknown-key");
  });

  it("refuses a document whose declared length is over the cap", async () => {
    expect(
      await reason(
        always(() =>
          Promise.resolve(
            new Response("{}", {
              headers: {
                "content-length": String(600 * 1024),
                "content-type": "application/json",
              },
            }),
          ),
        ),
      ),
    ).toBe("unknown-key");
  });

  it("refuses a body that cannot be read", async () => {
    // A connection that drops mid-response. Unguarded, `.text()` rejects out of
    // the auth path as an unhandled rejection rather than a 401.
    expect(
      await reason(
        always(() =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error("connection reset"));
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ).toBe("unknown-key");
  });

  it("refuses a document that is not JSON", async () => {
    expect(
      await reason(always(() => Promise.resolve(new Response("<html>")))),
    ).toBe("unknown-key");
  });

  it("refuses a document that is JSON but not an object", async () => {
    expect(
      await reason(always(() => Promise.resolve(new Response("123")))),
    ).toBe("unknown-key");
  });

  it("refuses when discovery succeeds but the JWKS 404s", async () => {
    const fetchImpl = ((url: string | URL) =>
      String(url) === JWKS_URI
        ? Promise.resolve(new Response("gone", { status: 404 }))
        : Promise.resolve(
            new Response(
              JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URI }),
            ),
          )) as unknown as typeof fetch;
    expect(await reason(fetchImpl)).toBe("unknown-key");
  });

  it("gives up when a refetch still does not have the kid", async () => {
    // The IdP is reachable and answering, it simply does not have the key the
    // token names. One refetch, then a refusal — never a loop.
    const { calls, fetchImpl } = idp({ keys: [rsa.jwk] });
    const clock = { ms: NOW_MS };
    const issuer = verifier(fetchImpl, { now: () => clock.ms });
    expect((await issuer.verify(await sign(rsa), verifyOptions)).ok).toBe(true);

    clock.ms += 61_000;
    const stranger = await generate("RS256", "never-published");
    const before = calls.length;
    const verdict = await issuer.verify(await sign(stranger), verifyOptions);
    expect(!verdict.ok && verdict.reason).toBe("unknown-key");
    expect(calls.length).toBeGreaterThan(before);
  });

  it("defaults its clock to the real one", async () => {
    const { fetchImpl } = idp({ keys: [rsa.jwk] });
    const issuer = createExternalIssuer(ISSUER, { fetchImpl });
    const verdict = await issuer.verify(
      await sign(rsa, claims({ exp: Math.floor(Date.now() / 1000) + 3600 })),
      { audience: RESOURCE, now: Date.now },
    );
    expect(verdict.ok).toBe(true);
  });
});
