import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type PendingAuthorization } from "./codes";
import {
  type AccessTokenClaims,
  signConsentToken,
  signToken,
  verifyConsentToken,
  verifyToken,
} from "./tokens";

const SECRET = "s".repeat(64);
const ISSUER = "https://box.tail1234.ts.net";
const RESOURCE = `${ISSUER}/mcp`;

/** Epoch milliseconds. `exp`/`iat` are seconds, per JWT. */
const NOW_MS = 1_000_000_000;

function claims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return {
    aud: RESOURCE,
    exp: NOW_MS / 1000 + 3600,
    iat: NOW_MS / 1000,
    iss: ISSUER,
    jti: "token-id",
    scope: "espresso:read espresso:write",
    sub: "owner",
    ...overrides,
  };
}

function verify(token: string, now: number = NOW_MS) {
  return verifyToken(token, {
    audience: RESOURCE,
    expectedIssuer: ISSUER,
    now: () => now,
    secret: SECRET,
  });
}

describe("signToken", () => {
  it("mints a three-segment compact JWS", () => {
    const token = signToken(claims(), SECRET, "access-token");
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    expect(
      JSON.parse(Buffer.from(segments[0] as string, "base64url").toString()),
    ).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("round-trips the claims verbatim", () => {
    const verdict = verify(signToken(claims(), SECRET, "access-token"));
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.claims).toEqual(claims());
  });

  it("is deterministic, so a token is stable across restarts", () => {
    // The point of deriving the key from a stable secret rather than generating
    // one: a `docker compose up` must not sign the owner out of their phone.
    expect(signToken(claims(), SECRET, "access-token")).toBe(
      signToken(claims(), SECRET, "access-token"),
    );
  });
});

describe("verifyToken", () => {
  it("accepts a token it just minted", () => {
    expect(verify(signToken(claims(), SECRET, "access-token")).ok).toBe(true);
  });

  it("rejects anything that is not three segments", () => {
    for (const malformed of ["", "a", "a.b", "a.b.c.d"]) {
      const verdict = verify(malformed);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toBe("malformed");
    }
  });

  it("rejects a correctly signed payload that is not JSON", () => {
    // Signed with the real key, so this gets *past* the signature check and
    // fails on decode — the branch that would otherwise `JSON.parse`-throw
    // straight out of the fetch handler. `signToken` cannot produce it, since
    // it stringifies, so the token is assembled here from the same primitives
    // the module documents. That the forgery verifies at all is itself the
    // check that the format is what the comment says it is.
    const key = hkdfSync(
      "sha256",
      SECRET,
      "gaggiuino-mcp/oauth/v1",
      "access-token",
      32,
    );
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
      "base64url",
    );
    const payload = Buffer.from("not json at all").toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", Buffer.from(key))
      .update(signingInput, "utf8")
      .digest("base64url");

    const verdict = verify(`${signingInput}.${signature}`);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("rejects a correctly signed payload that is JSON but not an object", () => {
    const key = hkdfSync(
      "sha256",
      SECRET,
      "gaggiuino-mcp/oauth/v1",
      "access-token",
      32,
    );
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
      "base64url",
    );
    const payload = Buffer.from("null").toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", Buffer.from(key))
      .update(signingInput, "utf8")
      .digest("base64url");

    const verdict = verify(`${signingInput}.${signature}`);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("rejects a payload missing a required claim", () => {
    const partial = { ...claims() } as Record<string, unknown>;
    delete partial.scope;
    const token = signToken(
      partial as unknown as AccessTokenClaims,
      SECRET,
      "access-token",
    );
    const verdict = verify(token);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("malformed");
  });

  it("rejects a signature made with a different secret", () => {
    const token = signToken(claims(), "d".repeat(64), "access-token");
    const verdict = verify(token);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and the length here is
    // attacker-controlled. A throw would be a 500 out of the fetch handler.
    const [header, payload] = signToken(claims(), SECRET, "access-token").split(
      ".",
    );
    const verdict = verify(
      `${header}.${payload}.${Buffer.from("short").toString("base64url")}`,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });

  it("rejects a tampered payload", () => {
    const token = signToken(claims(), SECRET, "access-token");
    const [header, , signature] = token.split(".");
    const escalated = Buffer.from(
      JSON.stringify(claims({ scope: "espresso:read espresso:write admin" })),
    ).toString("base64url");
    const verdict = verify(`${header}.${escalated}.${signature}`);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });

  it("rejects a refresh token presented as an access token", () => {
    // The whole point of the HKDF `info` split: same secret, different derived
    // key, so a refresh token cannot be replayed against /mcp.
    const refresh = signToken(claims(), SECRET, "refresh-token");
    const verdict = verify(refresh);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("bad-signature");
  });

  it("accepts a refresh token when verified as one", () => {
    const refresh = signToken(claims(), SECRET, "refresh-token");
    const verdict = verifyToken(
      refresh,
      {
        audience: RESOURCE,
        expectedIssuer: ISSUER,
        now: () => NOW_MS,
        secret: SECRET,
      },
      "refresh-token",
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects a token from a different issuer", () => {
    const token = signToken(
      claims({ iss: "https://evil.test" }),
      SECRET,
      "access-token",
    );
    const verdict = verify(token);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("wrong-issuer");
  });

  it("rejects an expired token", () => {
    const token = signToken(claims(), SECRET, "access-token");
    const expiresAtMs = claims().exp * 1000;
    expect(verify(token, expiresAtMs - 1).ok).toBe(true);
    const verdict = verify(token, expiresAtMs);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("expired");
  });

  it("rejects a token minted for a different resource", () => {
    // The audience check is the security core: a token this user consented to
    // give some other MCP server must not work here.
    const token = signToken(
      claims({ aud: "https://someone-else.ts.net/mcp" }),
      SECRET,
      "access-token",
    );
    const verdict = verify(token);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("wrong-audience");
  });

  it("accepts the canonical variants of its own resource", () => {
    // Claude sends the RFC 8707 canonical form, which need not be byte-equal to
    // what the user typed into the connector dialog. A strict comparison here
    // rejects tokens that are perfectly valid.
    for (const audience of [
      RESOURCE,
      `${RESOURCE}/`,
      "https://BOX.TAIL1234.TS.NET/mcp",
      "https://box.tail1234.ts.net:443/mcp",
    ]) {
      const token = signToken(
        claims({ aud: audience }),
        SECRET,
        "access-token",
      );
      expect(verify(token).ok, audience).toBe(true);
    }
  });

  it("rejects an audience that is not a URL, without throwing", () => {
    // `checkResourceAllowed` throws on an unparseable value, and `aud` is
    // attacker-controlled once the signature is theirs to make. It never is
    // here — but the branch has to refuse rather than crash.
    const token = signToken(
      claims({ aud: "not-a-url" }),
      SECRET,
      "access-token",
    );
    const verdict = verify(token);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("wrong-audience");
  });

  it("rejects an audience that only prefixes the resource", () => {
    const token = signToken(
      claims({ aud: "https://box.tail1234.ts.net" }),
      SECRET,
      "access-token",
    );
    expect(verify(token).ok).toBe(false);
  });

  it("defaults its clock to the real one", () => {
    // The `now` default is a branch, and an expiry an hour out proves it is
    // reading a real clock rather than zero.
    const token = signToken(
      claims({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      SECRET,
      "access-token",
    );
    expect(
      verifyToken(token, {
        audience: RESOURCE,
        expectedIssuer: ISSUER,
        secret: SECRET,
      }).ok,
    ).toBe(true);
  });
});

const CONSENT_TTL_MS = 10 * 60_000;

function pending(
  overrides: Partial<PendingAuthorization> = {},
): PendingAuthorization {
  return {
    clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    clientName: "Claude",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    resource: RESOURCE,
    scopes: ["espresso:read", "espresso:write"],
    state: "opaque-state",
    ...overrides,
  };
}

/**
 * Sign an arbitrary payload under a chosen HKDF domain.
 *
 * Two jobs. With the default `info` it reaches decode branches `signConsentToken`
 * cannot produce, since that function stringifies a typed object. With a
 * *different* `info` it isolates the domain split: the same bytes signed under
 * the wrong key, so a refusal can only be the signature.
 */
function forgeConsent(payload: string, info = "consent"): string {
  const key = hkdfSync("sha256", SECRET, "gaggiuino-mcp/oauth/v1", info, 32);
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const signingInput = `${header}.${Buffer.from(payload).toString("base64url")}`;
  const signature = createHmac("sha256", Buffer.from(key))
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("consent tokens", () => {
  it("round-trips the authorization request the page was rendered for", () => {
    // `handlePost` binds an authorization code to exactly this object, so a
    // dropped field is a code bound to something the owner never saw.
    const token = signConsentToken(pending(), SECRET, () => NOW_MS);
    expect(verifyConsentToken(token, SECRET, () => NOW_MS)).toEqual(pending());
  });

  it("survives a request with every optional field absent", () => {
    const bare = pending({
      clientName: undefined,
      resource: undefined,
      state: undefined,
    });
    const token = signConsentToken(bare, SECRET, () => NOW_MS);
    expect(verifyConsentToken(token, SECRET, () => NOW_MS)).toEqual(bare);
  });

  it("mints a distinct token every time, on one clock", () => {
    // The retry page after a wrong passphrase re-signs the same request at
    // (potentially) the same millisecond. Without the random `jti` the owner
    // would be handed back a token byte-identical to the one they just
    // submitted, and `flow.test.ts`'s fresh-token assertion would be measuring
    // scrypt's runtime rather than anything this module does.
    const first = signConsentToken(pending(), SECRET, () => NOW_MS);
    const second = signConsentToken(pending(), SECRET, () => NOW_MS);
    expect(first).not.toBe(second);
  });

  it("hands back nothing but a PendingAuthorization", () => {
    // The store this replaced returned its own map entry, `expiresAt` and all,
    // through a signature that promised a `PendingAuthorization`. Rebuilding the
    // object field by field is what stops the expiry — or a `jti`, or a key a
    // later version adds — riding along into an issued code.
    const token = signConsentToken(pending(), SECRET, () => NOW_MS);
    const recovered = verifyConsentToken(token, SECRET, () => NOW_MS);
    expect(Object.keys(recovered ?? {}).sort()).toEqual(
      Object.keys(pending()).sort(),
    );
  });

  it("drops payload keys it does not model", () => {
    const token = forgeConsent(
      JSON.stringify({
        ...pending(),
        exp: NOW_MS + CONSENT_TTL_MS,
        smuggled: "value",
      }),
    );
    const recovered = verifyConsentToken(token, SECRET, () => NOW_MS);
    expect(recovered).toEqual(pending());
    expect(recovered).not.toHaveProperty("smuggled");
  });

  it("holds a consent page for the full ten minutes", () => {
    // Well past a code's sixty seconds: the owner is reading the page and
    // typing a passphrase, not following a redirect.
    const token = signConsentToken(pending(), SECRET, () => NOW_MS);
    expect(
      verifyConsentToken(token, SECRET, () => NOW_MS + CONSENT_TTL_MS - 1),
    ).toBeDefined();
    expect(
      verifyConsentToken(token, SECRET, () => NOW_MS + CONSENT_TTL_MS),
    ).toBeUndefined();
  });

  it("refuses a token signed with a different secret", () => {
    const token = signConsentToken(pending(), "d".repeat(64), () => NOW_MS);
    expect(verifyConsentToken(token, SECRET, () => NOW_MS)).toBeUndefined();
  });

  it("refuses a tampered payload", () => {
    // The scope list is the interesting one: it is what the consent page
    // *displayed*, so a payload edited in flight would grant something the owner
    // was never shown.
    const [header, , signature] = signConsentToken(
      pending(),
      SECRET,
      () => NOW_MS,
    ).split(".");
    const escalated = Buffer.from(
      JSON.stringify({
        ...pending({ scopes: ["espresso:read", "espresso:write", "admin"] }),
        exp: NOW_MS + CONSENT_TTL_MS,
      }),
    ).toString("base64url");
    expect(
      verifyConsentToken(`${header}.${escalated}.${signature}`, SECRET),
    ).toBeUndefined();
  });

  it("refuses anything that is not three segments", () => {
    for (const malformed of ["", "a", "a.b", "a.b.c.d"]) {
      expect(verifyConsentToken(malformed, SECRET), malformed).toBeUndefined();
    }
  });

  it("refuses a signature of the wrong length without throwing", () => {
    const [header, payload] = signConsentToken(pending(), SECRET).split(".");
    expect(
      verifyConsentToken(
        `${header}.${payload}.${Buffer.from("short").toString("base64url")}`,
        SECRET,
      ),
    ).toBeUndefined();
  });

  it("refuses a correctly signed payload that is not an object", () => {
    for (const payload of ["not json at all", "null", '"a string"']) {
      expect(
        verifyConsentToken(forgeConsent(payload), SECRET, () => NOW_MS),
        payload,
      ).toBeUndefined();
    }
  });

  it("refuses a correctly signed payload missing a required field", () => {
    for (const field of [
      "clientId",
      "codeChallenge",
      "exp",
      "redirectUri",
      "scopes",
    ]) {
      const claims: Record<string, unknown> = {
        ...pending(),
        exp: NOW_MS + CONSENT_TTL_MS,
      };
      delete claims[field];
      expect(
        verifyConsentToken(
          forgeConsent(JSON.stringify(claims)),
          SECRET,
          () => NOW_MS,
        ),
        field,
      ).toBeUndefined();
    }
  });

  it("refuses a scopes array carrying anything but strings", () => {
    // `scopes` reaches `renderConsentPage` and then an issued token's `scope`
    // claim. A non-string in there would be rendered and then joined into a
    // credential.
    const token = forgeConsent(
      JSON.stringify({
        ...pending(),
        exp: NOW_MS + CONSENT_TTL_MS,
        scopes: ["espresso:read", { evil: true }],
      }),
    );
    expect(verifyConsentToken(token, SECRET, () => NOW_MS)).toBeUndefined();
  });

  it("is domain-separated from access and refresh tokens", () => {
    // Same secret, different HKDF `info`. A consent token is handed to a browser
    // *before* any passphrase is checked, so one that verified as an access
    // token would skip both consent and the machine's write gate.
    //
    // The `reason` is the assertion, not just `ok: false`. A consent payload
    // carries no `aud`/`iss`/`sub`, so it fails `decodeClaims` as "malformed"
    // whatever key signed it — meaning a bare `ok: false` here passes just as
    // happily when the two share one key, which is the bug this is meant to
    // catch. Only "bad-signature" says the *key* refused it.
    const consent = signConsentToken(pending(), SECRET, () => NOW_MS);
    for (const kind of ["access-token", "refresh-token"] as const) {
      const verdict = verifyToken(
        consent,
        { audience: RESOURCE, expectedIssuer: ISSUER, secret: SECRET },
        kind,
      );
      expect(verdict.ok, kind).toBe(false);
      expect(!verdict.ok && verdict.reason, kind).toBe("bad-signature");
    }

    // And the reverse, with the payload held constant so the refusal cannot be
    // the structural check: these are bytes `verifyConsentToken` accepts when
    // they are signed under "consent" (see "drops payload keys it does not
    // model"), refused here only because an access token's key signed them.
    const smuggled = JSON.stringify({
      ...pending(),
      exp: NOW_MS + CONSENT_TTL_MS,
    });
    expect(
      verifyConsentToken(
        forgeConsent(smuggled, "access-token"),
        SECRET,
        () => NOW_MS,
      ),
    ).toBeUndefined();
    expect(
      verifyConsentToken(forgeConsent(smuggled), SECRET, () => NOW_MS),
    ).toEqual(pending());
  });

  it("defaults its clocks to the real one", () => {
    // Two defaults, one on each side. A `now` stuck at zero would mint a token
    // that expired in 1970 and refuse it on the same call.
    expect(
      verifyConsentToken(signConsentToken(pending(), SECRET), SECRET),
    ).toEqual(pending());
  });
});
