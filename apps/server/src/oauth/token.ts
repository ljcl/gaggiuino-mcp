import { createHash, randomUUID } from "node:crypto";
import { logger } from "../logging";
import { type CodeStore } from "./codes";
import { type AuthServerConfig } from "./metadata";
import { ALL_SCOPES_HEADER } from "./scopes";
import { type AccessTokenClaims, signToken, verifyToken } from "./tokens";

/**
 * `/oauth/token` — the authorization code and refresh grants.
 *
 * Two shapes of failure matter here and both are RFC 6749 codes, not prose:
 * Claude's refresh handling keys on `invalid_grant` specifically, and a custom
 * code (or an `invalid_request` where `invalid_grant` belongs) breaks it.
 */

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface TokenDeps {
  codes: CodeStore;
  config: AuthServerConfig;
  now?: () => number;
  /** Highest refresh generation seen per client. See `AccessTokenClaims.gen`. */
  generations?: Map<string, number>;
}

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
      status,
    },
  );
}

function issue(
  config: AuthServerConfig,
  audience: string,
  scopes: string[],
  subject: string,
  nowMs: number,
  generation: number,
): Response {
  const seconds = Math.floor(nowMs / 1000);
  const base = {
    aud: audience,
    iat: seconds,
    iss: config.issuer,
    scope: scopes.join(" "),
    sub: subject,
  };
  const accessToken = signToken(
    { ...base, exp: seconds + ACCESS_TOKEN_TTL_SECONDS, jti: randomUUID() },
    config.secret,
    "access-token",
  );
  const refreshToken = signToken(
    {
      ...base,
      exp: seconds + REFRESH_TOKEN_TTL_SECONDS,
      gen: generation,
      jti: randomUUID(),
    },
    config.secret,
    "refresh-token",
  );
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      token_type: "Bearer",
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
      status: 200,
    },
  );
}

/**
 * The audience a token is minted for.
 *
 * Claude sends `resource` on the token request; when it does, that is what the
 * token is good for. When it does not, this server's own resource is the only
 * sensible answer — it is the only thing these tokens are ever presented to.
 */
function audienceFor(config: AuthServerConfig, requested?: string): string {
  return requested && requested.length > 0 ? requested : config.resource;
}

function handleAuthorizationCode(
  form: URLSearchParams,
  deps: TokenDeps,
  nowMs: number,
): Response {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const redeemed = deps.codes.redeem(code);

  if (!redeemed) {
    // Unknown, expired, or already spent — all the same answer, because
    // distinguishing them tells a caller which half of a guess was right.
    return oauthError("invalid_grant", "The authorization code is not valid");
  }
  if (redeemed.clientId !== form.get("client_id")) {
    return oauthError(
      "invalid_grant",
      "The authorization code was issued to a different client",
    );
  }
  // Bound at issue and re-checked here: a code stolen in transit cannot be
  // redeemed against a redirect_uri the owner never saw.
  const presentedRedirect = form.get("redirect_uri");
  if (
    presentedRedirect !== null &&
    presentedRedirect !== redeemed.redirectUri
  ) {
    return oauthError(
      "invalid_grant",
      "The redirect_uri does not match the one this code was issued for",
    );
  }
  if (!verifier) {
    return oauthError("invalid_request", "code_verifier is required");
  }

  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  if (challenge !== redeemed.codeChallenge) {
    return oauthError("invalid_grant", "The PKCE verifier does not match");
  }

  logger.info("oauth.token_issued", {
    clientId: redeemed.clientId,
    grant: "authorization_code",
  });
  return issue(
    deps.config,
    audienceFor(deps.config, redeemed.resource),
    redeemed.scopes,
    "owner",
    nowMs,
    1,
  );
}

function handleRefresh(
  form: URLSearchParams,
  deps: TokenDeps,
  nowMs: number,
): Response {
  const presented = form.get("refresh_token") ?? "";
  const verdict = verifyToken(
    presented,
    {
      // A refresh token's `aud` is whatever the access token it renews carries,
      // so it is checked against the same resource rather than re-derived.
      audience: deps.config.resource,
      expectedIssuer: deps.config.issuer,
      now: () => nowMs,
      secret: deps.config.secret,
    },
    "refresh-token",
  );
  if (!verdict.ok) {
    return oauthError("invalid_grant", "The refresh token is not valid");
  }

  const claims: AccessTokenClaims = verdict.claims;
  const clientId = form.get("client_id") ?? "";
  const generations = deps.generations ?? new Map<string, number>();
  const seen = generations.get(clientId) ?? 0;
  const generation = claims.gen ?? 0;

  if (generation < seen) {
    // Superseded, which means replayed. Bounded detection, not revocation —
    // this is in memory and a restart forgets it.
    logger.warn("oauth.refresh_replayed", { clientId, generation, seen });
    return oauthError(
      "invalid_grant",
      "This refresh token has already been used",
    );
  }
  generations.set(clientId, generation + 1);

  logger.info("oauth.token_issued", { clientId, grant: "refresh_token" });
  // The new refresh token is returned in the same response that supersedes the
  // old one, which is what rotation means for a public client.
  return issue(
    deps.config,
    claims.aud,
    claims.scope.split(" ").filter(Boolean),
    claims.sub,
    nowMs,
    generation + 1,
  );
}

export async function handleToken(
  req: Request,
  deps: TokenDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      headers: { Allow: "POST" },
      status: 405,
    });
  }

  // Must be form-urlencoded, per RFC 6749 — reading this as JSON is the
  // documented tripwire that answers 415 and breaks the flow.
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return oauthError("invalid_request", "The request body could not be read");
  }

  const nowMs = (deps.now ?? Date.now)();
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(form, deps, nowMs);
  }
  if (grantType === "refresh_token") {
    return handleRefresh(form, deps, nowMs);
  }
  return oauthError(
    "unsupported_grant_type",
    `Supported grants are authorization_code and refresh_token; scopes are ${ALL_SCOPES_HEADER}`,
  );
}
