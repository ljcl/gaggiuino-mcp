import { webcrypto } from "node:crypto";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createCache, type TtlCache } from "../cache";
import { logger } from "../logging";
import { type TokenFailure } from "./tokens";

/**
 * Verifying access tokens minted by somebody else's authorization server.
 *
 * The built-in AS signs HS256 with a key derived from `MCP_OAUTH_SECRET`, which
 * works precisely because the same process mints and checks the token. An
 * external issuer signs with a private key this server never sees, so
 * verification becomes: discover the issuer's metadata, fetch its JWKS, find the
 * key the token names, and check an asymmetric signature.
 *
 * `crypto.subtle` does all of it, so this adds **no production dependency** —
 * the same constraint `tokens.ts` holds itself to. `jose` was the alternative
 * and would have become a direct dependency of `@gaggiuino/server`, which
 * Dependabot then bumps as `fix(deps):`, cutting a patch release every time,
 * because it ships inside the published image.
 *
 * ### Two rules that are load-bearing
 *
 * **The algorithm allowlist is a security control, not a compatibility list.**
 * Only RS256 and ES256 reach a key import. That is what makes the classic
 * algorithm-confusion attack unreachable: an attacker who takes the issuer's
 * *public* key from the JWKS and signs a token `HS256` with it is handing us a
 * token whose `alg` we refuse to look up at all. `alg: "none"` dies in the same
 * branch. Widening this list is not a cosmetic change.
 *
 * **A cache miss on `kid` may refetch, but not on demand.** Rotating a signing
 * key has to work without a restart, so an unrecognised `kid` refetches the
 * JWKS. Left there, that is an unauthenticated caller with a remote-fetch
 * trigger: tokens carrying random `kid`s would each drive a request to the IdP.
 * `REFETCH_COOLDOWN_MS` bounds it to one refetch per issuer per minute, which is
 * far faster than any real rotation needs and turns the flood into a no-op.
 */

/**
 * How long a discovery document and a key set are trusted.
 *
 * Both are effectively static — an IdP's endpoints do not move and its signing
 * keys rotate on the order of months. The TTL is a backstop for the case the
 * `kid` refetch does not cover: a key *removed* from the set while its `kid` is
 * still one we hold.
 */
const METADATA_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;

/** Minimum gap between `kid`-triggered refetches. See the module docblock. */
const REFETCH_COOLDOWN_MS = 60_000;

/** A discovery or JWKS fetch that outlives this is a broken IdP, not a slow one. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Refuse a discovery or JWKS body past this size.
 *
 * The IdP is operator-configured and so not hostile by assumption, but it is
 * still a remote host whose response length this process would otherwise
 * allocate on trust. A real JWKS is a few kilobytes.
 */
const MAX_DOCUMENT_BYTES = 512 * 1024;

/** The JOSE algorithms this server will verify. See the module docblock. */
const SUPPORTED_ALGORITHMS = {
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const satisfies Record<
  string,
  {
    importParams: webcrypto.EcKeyImportParams | webcrypto.RsaHashedImportParams;
    verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams;
  }
>;

type SupportedAlgorithm = keyof typeof SUPPORTED_ALGORITHMS;

function isSupportedAlgorithm(alg: unknown): alg is SupportedAlgorithm {
  return typeof alg === "string" && alg in SUPPORTED_ALGORITHMS;
}

/** What this server needs out of a verified token. */
export interface ExternalClaims {
  /** Space-delimited, per RFC 6749. Normalised from `scope` or `scp`. */
  scope: string;
  sub: string;
}

export type ExternalVerdict =
  | { claims: ExternalClaims; ok: true }
  | { ok: false; reason: TokenFailure };

export interface ExternalIssuerOptions {
  /** Injected so tests drive discovery without a network or msw handler. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A JWKS entry. `kid` is what a token's header names a key by. */
type Jwk = webcrypto.JsonWebKey & { kid?: string };

interface KeySet {
  /** When the set was last fetched, for the refetch cooldown. */
  fetchedAt: number;
  keys: Jwk[];
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * The two discovery URLs, in the order Claude itself probes them.
 *
 * RFC 8414 inserts its well-known segment *before* the issuer's path, while
 * OIDC appends its own after — so for an issuer like
 * `https://idp.example/realms/home` the two are genuinely different URLs, not a
 * suffix apart. Getting that wrong is the whole Keycloak/Authentik case, since
 * those issuers always carry a path.
 *
 * Most hosted identity providers serve only the OIDC document, which is why the
 * fallback is not optional.
 */
export function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("oauth.issuer_unreachable", {
      reason: error instanceof Error ? error.message : String(error),
      url,
    });
    return undefined;
  }
  if (!response.ok) {
    logger.warn("oauth.issuer_http_error", { status: response.status, url });
    return undefined;
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCUMENT_BYTES) {
    logger.warn("oauth.issuer_document_too_large", { bytes: declared, url });
    return undefined;
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return undefined;
  }
  // Re-checked after reading, because `content-length` is a claim rather than a
  // guarantee — a chunked response carries none at all.
  if (body.length > MAX_DOCUMENT_BYTES) {
    logger.warn("oauth.issuer_document_too_large", { bytes: body.length, url });
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    logger.warn("oauth.issuer_document_malformed", { url });
    return undefined;
  }
}

/**
 * Find the issuer's JWKS URI, or `undefined` if discovery fails.
 *
 * The document's own `issuer` is checked against the configured one, and that is
 * not a formality: it is what stops a redirect — or an operator's typo landing
 * on somebody else's tenant — from silently substituting a different key set for
 * the one this server is meant to trust. RFC 8414 §3.3 requires the check.
 */
async function discoverJwksUri(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  for (const url of discoveryUrls(issuer)) {
    const document = await fetchJson(url, fetchImpl);
    if (!document) continue;

    if (document.issuer !== issuer) {
      logger.warn("oauth.issuer_mismatch", {
        advertised: String(document.issuer),
        configured: issuer,
        url,
      });
      continue;
    }
    const jwksUri = document.jwks_uri;
    if (typeof jwksUri !== "string" || jwksUri.length === 0) {
      logger.warn("oauth.issuer_no_jwks_uri", { url });
      continue;
    }
    logger.info("oauth.issuer_discovered", { jwksUri, url });
    return jwksUri;
  }
  return undefined;
}

async function fetchKeys(
  jwksUri: string,
  fetchImpl: typeof fetch,
): Promise<Jwk[] | undefined> {
  const document = await fetchJson(jwksUri, fetchImpl);
  if (!document) return undefined;
  const keys = document.keys;
  if (!Array.isArray(keys)) {
    logger.warn("oauth.jwks_malformed", { jwksUri });
    return undefined;
  }
  return keys.filter(
    (key: unknown): key is Jwk =>
      typeof key === "object" &&
      key !== null &&
      // A JWKS routinely carries encryption keys beside signing ones, and an
      // IdP is free to reuse a `kid` across the two. Dropping `use: "enc"` here
      // means a token is never matched against a key that was never meant to
      // verify one — which would present as an intermittent auth failure that
      // depends on the order the IdP happened to list its keys in.
      (!("use" in key) || key.use === undefined || key.use === "sig"),
  );
}

/**
 * Verification against one external authorization server.
 *
 * A factory rather than module state, so two tests cannot see each other's
 * cached key set — the same reason `oauth/router.ts` is one. In production there
 * is exactly one, created with the handler.
 */
export interface ExternalIssuer {
  verify(
    token: string,
    options: { audience: string; now: () => number },
  ): Promise<ExternalVerdict>;
}

export function createExternalIssuer(
  issuer: string,
  { fetchImpl = fetch, now = Date.now }: ExternalIssuerOptions = {},
): ExternalIssuer {
  // Two entries at most, and both for one issuer. `createCache` is used rather
  // than a pair of fields so the TTL semantics are the ones already tested.
  const cache: TtlCache<string | KeySet> = createCache({ maxEntries: 4, now });
  const METADATA_KEY = "jwks-uri";
  const KEYS_KEY = "keys";

  async function jwksUri(): Promise<string | undefined> {
    const cached = cache.get(METADATA_KEY);
    if (typeof cached === "string") return cached;
    const discovered = await discoverJwksUri(issuer, fetchImpl);
    if (discovered) cache.set(METADATA_KEY, discovered, METADATA_TTL_MS);
    return discovered;
  }

  async function keySet(): Promise<KeySet | undefined> {
    const cached = cache.get(KEYS_KEY);
    if (cached && typeof cached !== "string") return cached;
    const uri = await jwksUri();
    if (!uri) return undefined;
    const keys = await fetchKeys(uri, fetchImpl);
    if (!keys) return undefined;
    const set: KeySet = { fetchedAt: now(), keys };
    cache.set(KEYS_KEY, set, JWKS_TTL_MS);
    return set;
  }

  /**
   * The key a token names, refetching once if its `kid` is unrecognised.
   *
   * The refetch is what lets a rotated signing key work without a restart. The
   * cooldown is what stops it being a remote-fetch trigger any unauthenticated
   * caller can pull — see the module docblock.
   */
  async function findKey(kid: string | undefined): Promise<Jwk | undefined> {
    // With no `kid` the first signing key is the only available guess. That is
    // safe in practice because an IdP holding more than one key emits `kid` on
    // every token — it is how rotation is meant to work — and unsafe only for an
    // IdP that rotates without labelling, which cannot be disambiguated anyway.
    const matches = (set: KeySet) =>
      kid === undefined ? set.keys[0] : set.keys.find((key) => key.kid === kid);

    const set = await keySet();
    if (!set) return undefined;
    const found = matches(set);
    if (found) return found;

    if (now() - set.fetchedAt < REFETCH_COOLDOWN_MS) {
      logger.warn("oauth.jwks_refetch_throttled", { kid });
      return undefined;
    }
    logger.info("oauth.jwks_refetch", { kid });
    cache.delete(KEYS_KEY);
    const refreshed = await keySet();
    return refreshed ? matches(refreshed) : undefined;
  }

  return {
    async verify(token, { audience, now: tokenNow }) {
      const segments = token.split(".");
      if (segments.length !== 3) return { ok: false, reason: "malformed" };
      const [rawHeader, rawPayload, rawSignature] = segments as [
        string,
        string,
        string,
      ];

      const header = decodeJson(rawHeader);
      if (!header) return { ok: false, reason: "malformed" };
      if (!isSupportedAlgorithm(header.alg)) {
        // Named separately from a bad signature because it is the one failure an
        // operator can act on: it means their IdP signs with something this
        // server does not verify, not that the token was tampered with.
        logger.warn("oauth.unsupported_algorithm", { alg: String(header.alg) });
        return { ok: false, reason: "unsupported-algorithm" };
      }
      const algorithm = SUPPORTED_ALGORITHMS[header.alg];

      const kid = typeof header.kid === "string" ? header.kid : undefined;
      const jwk = await findKey(kid);
      if (!jwk) {
        return {
          ok: false,
          // Discovery failing and the key genuinely being absent are the same
          // answer to the caller and different lines in the log above.
          reason: "unknown-key",
        };
      }

      // Import and verify share one guard on purpose. Both failures mean the
      // same thing — the IdP published a key this runtime cannot use for this
      // token, rather than the token being wrong — so they deserve one reason
      // and one log line. Splitting them bought a second catch that no input
      // could reach, since a key/algorithm pair that survives `importKey` is one
      // `verify` will accept.
      let signatureValid: boolean;
      try {
        const key = await webcrypto.subtle.importKey(
          "jwk",
          jwk,
          algorithm.importParams,
          false,
          ["verify"],
        );
        signatureValid = await webcrypto.subtle.verify(
          algorithm.verifyParams,
          key,
          Buffer.from(rawSignature, "base64url"),
          Buffer.from(`${rawHeader}.${rawPayload}`, "utf8"),
        );
      } catch {
        logger.warn("oauth.jwks_key_unusable", { alg: header.alg, kid });
        return { ok: false, reason: "unknown-key" };
      }
      if (!signatureValid) return { ok: false, reason: "bad-signature" };

      // Only past the signature check is the payload anything but
      // attacker-controlled text — the same ordering `verifyToken` documents.
      const claims = decodeJson(rawPayload);
      if (!claims) return { ok: false, reason: "malformed" };

      if (claims.iss !== issuer) return { ok: false, reason: "wrong-issuer" };
      if (typeof claims.exp !== "number")
        return { ok: false, reason: "malformed" };
      if (claims.exp * 1000 <= tokenNow())
        return { ok: false, reason: "expired" };

      const audienceMatch = audiencesOf(claims.aud).some((candidate) => {
        try {
          return checkResourceAllowed({
            configuredResource: audience,
            requestedResource: candidate,
          });
        } catch {
          // `checkResourceAllowed` throws on anything it cannot parse as a URL,
          // and `aud` is whatever the IdP put there. A throw is a refusal.
          return false;
        }
      });
      if (!audienceMatch) return { ok: false, reason: "wrong-audience" };

      const sub = typeof claims.sub === "string" ? claims.sub : undefined;
      if (!sub) return { ok: false, reason: "malformed" };

      return { claims: { scope: scopeOf(claims), sub }, ok: true };
    },
  };
}

/**
 * `aud` is a string or an array of them, per RFC 7519 §4.1.3.
 *
 * Every IdP that can address more than one resource emits the array form, so
 * reading only the string would reject a correctly configured token from most
 * of them.
 */
function audiencesOf(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud))
    return aud.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * The granted scopes, from whichever claim the IdP used.
 *
 * `scope` (space-delimited) is the RFC 6749 spelling and what Keycloak, Authelia
 * Authentik, Zitadel and Auth0 emit. `scp` is Microsoft Entra's, and appears as
 * both a string and an array in the wild. Reading only `scope` would leave an
 * Entra deployment authenticated but holding nothing, which presents as every
 * write being refused with no explanation.
 */
function scopeOf(claims: Record<string, unknown>): string {
  if (typeof claims.scope === "string") return claims.scope;
  if (typeof claims.scp === "string") return claims.scp;
  if (Array.isArray(claims.scp)) {
    return claims.scp
      .filter((v): v is string => typeof v === "string")
      .join(" ");
  }
  return "";
}
