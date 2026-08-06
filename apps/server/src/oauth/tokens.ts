import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

/**
 * Self-issued access and refresh tokens, signed with a key derived from one
 * environment secret.
 *
 * The format is a compact JWS (`header.payload.signature`, HS256) because that
 * is what every OAuth client already knows how to carry, not because anything
 * here needs to interoperate with a JWT library. Verification is `createHmac` +
 * `timingSafeEqual` from `node:crypto` — the same module `secretsMatch` already
 * uses — so this adds **no production dependency** to a distroless image.
 *
 * Two properties are deliberate:
 *
 * - **Stateless.** Nothing is stored, so a `docker compose up` does not log the
 *   owner out of their phone. The alternative — a generated key held in memory —
 *   invalidates every token on every restart, which on a home server that
 *   restarts for a firmware flash is a fresh consent prompt each time.
 * - **Domain-separated by HKDF `info`.** An access token and a refresh token are
 *   signed with different derived keys, so a refresh token can never be replayed
 *   as an access token even though both are minted from the same secret.
 */

/** HKDF salt. Fixed and public; the secret is the entropy, the salt is not. */
const HKDF_SALT = "gaggiuino-mcp/oauth/v1";

/** HMAC-SHA256 output length. Not secret — it is the same for every token. */
const SIGNATURE_BYTES = 32;

export type TokenKind = "access-token" | "refresh-token";

export interface AccessTokenClaims {
  /** RFC 8707 resource indicator: the MCP endpoint this token is good for. */
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  /** Unique id, so a token can be named in a log without logging the token. */
  jti: string;
  /** Space-delimited, per RFC 6749. */
  scope: string;
  sub: string;
}

function derivedKey(secret: string, kind: TokenKind): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, kind, 32));
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(signingInput: string, secret: string, kind: TokenKind): string {
  return createHmac("sha256", derivedKey(secret, kind))
    .update(signingInput, "utf8")
    .digest("base64url");
}

/** Mint a signed token. The claims are echoed verbatim into the payload. */
export function signToken(
  claims: AccessTokenClaims,
  secret: string,
  kind: TokenKind,
): string {
  const signingInput = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(claims)}`;
  return `${signingInput}.${sign(signingInput, secret, kind)}`;
}

/**
 * Why a token was refused.
 *
 * Carried into the `security.rejected` log rather than back to the caller: the
 * client is told only `invalid_token`, because distinguishing "expired" from
 * "signed with the wrong key" for an unauthenticated caller tells an attacker
 * which half of a guess was right. The operator gets the specific reason,
 * which is the person who actually has to fix it.
 */
export type TokenFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-issuer"
  | "wrong-audience";

export type TokenVerdict =
  | { claims: AccessTokenClaims; ok: true }
  | { ok: false; reason: TokenFailure };

export interface VerifyOptions {
  /** The canonical resource identifier this server answers as. */
  audience: string;
  /** Injectable clock, so expiry is asserted without waiting for it. */
  now?: () => number;
  expectedIssuer: string;
  secret: string;
}

function decodeClaims(segment: string): AccessTokenClaims | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const claims = parsed as Record<string, unknown>;
  if (
    typeof claims.aud !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.iss !== "string" ||
    typeof claims.scope !== "string" ||
    typeof claims.sub !== "string"
  ) {
    return undefined;
  }
  return claims as unknown as AccessTokenClaims;
}

/**
 * Verify a token, failing closed at every step.
 *
 * The order is signature first, then issuer, expiry and audience. Checking the
 * signature before reading any claim is what makes the rest safe to trust: an
 * unsigned payload is attacker-controlled text, and an `aud` check against it
 * proves nothing.
 *
 * The audience check goes through the SDK's `checkResourceAllowed` rather than a
 * string comparison. Claude sends the RFC 8707 canonical form of the URL — lower
 * -cased scheme and host, no trailing slash, no default port — which need not be
 * byte-identical to what the user typed into the connector dialog, and a strict
 * comparison rejects tokens that are perfectly valid.
 */
export function verifyToken(
  token: string,
  options: VerifyOptions,
  kind: TokenKind = "access-token",
): TokenVerdict {
  const { audience, expectedIssuer, now = Date.now, secret } = options;

  const segments = token.split(".");
  if (segments.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = segments as [string, string, string];

  const presented = Buffer.from(signature, "base64url");
  // Length is compared before `timingSafeEqual` because that function throws on
  // a mismatch. Unlike `secretsMatch`, no hashing is needed to make this safe:
  // an HMAC-SHA256 digest is always 32 bytes, so the length reveals nothing
  // about the key.
  if (presented.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "bad-signature" };
  }
  const expected = Buffer.from(
    sign(`${header}.${payload}`, secret, kind),
    "base64url",
  );
  if (!timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  const claims = decodeClaims(payload);
  if (!claims) return { ok: false, reason: "malformed" };

  if (claims.iss !== expectedIssuer)
    return { ok: false, reason: "wrong-issuer" };
  if (claims.exp * 1000 <= now()) return { ok: false, reason: "expired" };

  let audienceAllowed: boolean;
  try {
    audienceAllowed = checkResourceAllowed({
      configuredResource: audience,
      requestedResource: claims.aud,
    });
  } catch {
    // `checkResourceAllowed` throws on a value it cannot parse as a URL, which
    // an attacker controls. A throw here is a refusal, not a crash.
    return { ok: false, reason: "wrong-audience" };
  }
  if (!audienceAllowed) return { ok: false, reason: "wrong-audience" };

  return { claims, ok: true };
}
