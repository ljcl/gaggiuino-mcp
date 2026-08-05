import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AccessTokenClaims, signToken, verifyToken } from "./tokens";

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
