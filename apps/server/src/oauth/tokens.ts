import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { checkResourceAllowed } from "@modelcontextprotocol/server";
import { type PendingAuthorization } from "./codes";

/**
 * Every signed blob this server mints, from one environment secret.
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
 * - **Domain-separated by HKDF `info`.** Each kind is signed with a different
 *   derived key, so a refresh token can never be replayed as an access token and
 *   a consent token can never be redeemed as either, even though one secret
 *   mints all three.
 */

/** HKDF salt. Fixed and public; the secret is the entropy, the salt is not. */
const HKDF_SALT = "gaggiuino-mcp/oauth/v1";

/** HMAC-SHA256 output length. Not secret — it is the same for every token. */
const SIGNATURE_BYTES = 32;

/**
 * The three domains, and the HKDF `info` that separates them.
 *
 * Adding a kind here is adding a key. Reusing one across two purposes is what
 * the separation exists to prevent, so a new signed thing gets a new value
 * rather than borrowing the nearest one.
 */
export type TokenKind = "access-token" | "consent" | "refresh-token";

/**
 * The two kinds that are OAuth bearer tokens.
 *
 * `signToken`/`verifyToken` are typed against this rather than `TokenKind` so
 * the separation is a compile error as well as a different key: an
 * `AccessTokenClaims` cannot be signed into the consent domain by passing the
 * wrong string, and a consent token cannot be handed to `verifyToken` at all.
 */
export type BearerTokenKind = Exclude<TokenKind, "consent">;

export interface AccessTokenClaims {
  /** RFC 8707 resource indicator: the MCP endpoint this token is good for. */
  aud: string;
  /**
   * The client this grant belongs to, absent on access tokens.
   *
   * It is what `gen` is counted against, and it is a *claim* rather than the
   * `client_id` form field because the field is caller-supplied and never
   * verified — keying rotation on it would let whoever holds a stolen refresh
   * token sidestep replay detection by naming another client.
   *
   * Optional on the interface because access tokens do not carry it, **not**
   * because a refresh token may omit it: `handleRefresh` refuses one that does.
   */
  cid?: string;
  exp: number;
  /**
   * Refresh-token generation, absent on access tokens.
   *
   * Rotation is required of a public client, and this is what makes it
   * detectable rather than merely performed: a refresh token carries the
   * generation it was minted at, and the token endpoint keeps the highest one
   * it has issued per client in memory. A refresh token presented below that
   * has already been superseded, which means it was replayed.
   *
   * **Issued, not merely seen** — `claimGeneration` in `token.ts` advances the
   * counter for *both* grants. A fresh authorization that left it alone would
   * mint a token below the mark and refuse it on its first refresh, blaming a
   * replay for a credential this server had just issued.
   *
   * That memory is lost on restart, so this is **bounded replay detection and
   * not revocation** — a deliberate weakening for a single-user server that
   * would otherwise need a database. Said out loud here because a comment
   * naming a tradeoff is what stops it being quietly undone.
   */
  gen?: number;
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

/** Serialize claims as a compact JWS. The payload is echoed verbatim. */
function mint(claims: unknown, secret: string, kind: TokenKind): string {
  const signingInput = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(claims)}`;
  return `${signingInput}.${sign(signingInput, secret, kind)}`;
}

type SignatureVerdict =
  | { ok: false; reason: "bad-signature" | "malformed" }
  | { ok: true; payload: string };

/**
 * Check a token's signature and hand back its still-encoded payload.
 *
 * Every caller reads claims only from what this returns. That ordering is the
 * whole safety argument: an unverified payload is attacker-controlled text, and
 * a check against it proves nothing.
 */
function verifySignature(
  token: string,
  secret: string,
  kind: TokenKind,
): SignatureVerdict {
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
  return { ok: true, payload };
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

/** Mint a signed token. The claims are echoed verbatim into the payload. */
export function signToken(
  claims: AccessTokenClaims,
  secret: string,
  kind: BearerTokenKind,
): string {
  return mint(claims, secret, kind);
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
  | "wrong-audience"
  // Only reachable with an external issuer (`externalIssuer.ts`). Both are
  // operator-actionable in a way the others are not: "unknown-key" usually means
  // discovery or the JWKS fetch failed, and "unsupported-algorithm" means the
  // IdP signs with something other than RS256 or ES256.
  | "unknown-key"
  | "unsupported-algorithm";

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
  const claims = decodeSegment(segment);
  if (!claims) return undefined;
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
  kind: BearerTokenKind = "access-token",
): TokenVerdict {
  const { audience, expectedIssuer, now = Date.now, secret } = options;

  const verdict = verifySignature(token, secret, kind);
  if (!verdict.ok) return verdict;

  const claims = decodeClaims(verdict.payload);
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

/** How long a consent page stays submittable. The owner is reading it and
 *  typing a passphrase, not following a redirect. */
const CONSENT_TTL_MS = 10 * 60_000;

/**
 * Mint the `request_token` a consent page carries, over the request it was
 * rendered for.
 *
 * **Stateless, and therefore not single-use.** This request is served *before*
 * any passphrase is checked, so anything it stored would be a store an
 * unauthenticated caller controls the contents of — bounded-map eviction here
 * is the attack, not the recovery path, since an evicted consent page dead-ends
 * the owner mid-login. Storing nothing removes the store rather than guarding
 * it.
 *
 * The cost is that a captured consent submission can be replayed inside the TTL,
 * which is worth stating rather than assuming away. It is acceptable because the
 * token carries no authority on its own: the passphrase is checked on every
 * submission, and a submission an attacker captured *contains* that passphrase —
 * so single-use never protected against the one attacker it looked like it did.
 * A replay produces a fresh authorization code, which is still single-use and
 * still bound to the PKCE challenge and redirect URI the owner was shown.
 *
 * If single-use is wanted later, `jti` is there to key a seen-set on, and only
 * submissions that passed the passphrase would ever be recorded — so it would
 * not put a store back on the unauthenticated path.
 */
export function signConsentToken(
  request: PendingAuthorization,
  secret: string,
  now: () => number = Date.now,
): string {
  return mint(
    {
      ...request,
      exp: now() + CONSENT_TTL_MS,
      // Random per mint, so two tokens for the same request are never equal.
      // `authorize.ts` re-renders the page with a fresh token after a wrong
      // passphrase, and without this the retry would be handed back a token
      // byte-identical to the one it just submitted.
      jti: randomBytes(16).toString("base64url"),
    },
    secret,
    "consent",
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a consent token back, or `undefined` if it is forged, expired or
 * malformed.
 *
 * The three are one answer on purpose — the page they produce says only that it
 * expired, because telling an unauthenticated caller which of the three it hit
 * tells them which half of a guess was right.
 */
export function verifyConsentToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): PendingAuthorization | undefined {
  const verdict = verifySignature(token, secret, "consent");
  if (!verdict.ok) return undefined;

  const claims = decodeSegment(verdict.payload);
  if (!claims) return undefined;
  if (typeof claims.exp !== "number" || claims.exp <= now()) return undefined;

  const scopes = claims.scopes;
  if (
    typeof claims.clientId !== "string" ||
    typeof claims.codeChallenge !== "string" ||
    typeof claims.redirectUri !== "string" ||
    !Array.isArray(scopes) ||
    scopes.some((scope: unknown) => typeof scope !== "string")
  ) {
    return undefined;
  }

  // Rebuilt field by field rather than spread, so nothing the payload happens to
  // carry rides along into the object an authorization code is then bound to —
  // not the expiry, not the `jti`, not a key some future version adds.
  return {
    clientId: claims.clientId,
    clientName: optionalString(claims.clientName),
    codeChallenge: claims.codeChallenge,
    redirectUri: claims.redirectUri,
    resource: optionalString(claims.resource),
    scopes: scopes as string[],
    state: optionalString(claims.state),
  };
}
