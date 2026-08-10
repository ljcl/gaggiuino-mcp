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
  /**
   * Highest refresh generation *issued* per client. See `AccessTokenClaims.gen`
   * and `claimGeneration`.
   *
   * Required, because the one caller — `createOAuthRouter` — owns this map for
   * the life of the handler and there is no such thing as a token endpoint
   * without one. Optional, it read as a knob and behaved as a defect: a caller
   * that omitted it got a throwaway map per request, which is replay detection
   * that detects nothing.
   */
  generations: Map<string, number>;
}

/**
 * What a refusal was about, for the operator's log. Never sent to the caller.
 *
 * Both are nullable because both are read straight off the form on the paths
 * where nothing has been verified yet, and `null` is the honest record of a
 * field the caller did not send — distinct from a value this server chose not
 * to log.
 */
interface DenialContext {
  clientId?: string | null;
  grant?: string | null;
}

function oauthError(
  error: string,
  description: string,
  context: DenialContext = {},
  status = 400,
): Response {
  // Every refusal is logged here rather than at each `return`, because a silent
  // one is indistinguishable in the log from an exchange that never happened —
  // and those are opposite diagnoses. A connector that fails to reconnect after
  // consent leaves `oauth.authorized` with nothing after it either way: with
  // this line the code was presented and refused, without it the client never
  // came back for the token at all. Only success was logged before, so the one
  // question the log was needed for was the one it could not answer.
  //
  // The description is what the caller is told, so logging it leaks nothing.
  logger.warn("oauth.token_denied", { error, reason: description, ...context });
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

/**
 * The generation to mint a new refresh token at: one above anything this client
 * has already been given.
 *
 * **Both grants go through here, and that is the fix rather than a tidy-up.**
 * The authorization code grant used to issue a hardcoded generation 1 while
 * leaving the counter alone, so re-authorizing a connector that had already
 * rotated handed back a token *below* the high-water mark — superseded on
 * arrival. It worked for exactly one access-token lifetime and then died on its
 * first refresh as `oauth.refresh_replayed`, which reads as a stolen token and
 * is in fact this server refusing the credential it had just minted. The owner
 * re-consents, gets generation 1 again, and buys another hour; only a restart,
 * which empties the map, appears to fix it.
 *
 * The counter is therefore monotonic per client: whatever advances it, a token
 * issued earlier never outranks one issued later. The consequence worth stating
 * is that a *second* authorization for the same `client_id` supersedes the
 * first — reconnecting invalidates the session it replaced, which is what
 * reconnecting should mean.
 *
 * `presented` carries the generation a refresh grant arrived with, so a restart
 * that emptied the map re-establishes the high-water mark from the token itself
 * instead of starting again from zero. It is `0` for a code exchange, which
 * presents no prior token.
 */
function claimGeneration(
  deps: TokenDeps,
  clientId: string,
  presented = 0,
): number {
  // Only ever keyed by a client that got past the consent passphrase or
  // presented a token signed with this server's own secret, so this map is not
  // something an unauthenticated caller can grow.
  const next = Math.max(deps.generations.get(clientId) ?? 0, presented) + 1;
  deps.generations.set(clientId, next);
  return next;
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
  const grant = "authorization_code";

  if (!redeemed) {
    // Unknown, expired, or already spent — all the same answer, because
    // distinguishing them tells a caller which half of a guess was right.
    // The log gets the client's own `client_id`, which is the only identity
    // available when the code itself resolved to nothing.
    return oauthError("invalid_grant", "The authorization code is not valid", {
      clientId: form.get("client_id"),
      grant,
    });
  }
  const clientId = redeemed.clientId;
  if (clientId !== form.get("client_id")) {
    return oauthError(
      "invalid_grant",
      "The authorization code was issued to a different client",
      { clientId, grant },
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
      { clientId, grant },
    );
  }
  if (!verifier) {
    return oauthError("invalid_request", "code_verifier is required", {
      clientId,
      grant,
    });
  }

  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  if (challenge !== redeemed.codeChallenge) {
    return oauthError("invalid_grant", "The PKCE verifier does not match", {
      clientId,
      grant,
    });
  }

  logger.info("oauth.token_issued", { clientId, grant });
  return issue(
    deps.config,
    audienceFor(deps.config, redeemed.resource),
    redeemed.scopes,
    "owner",
    nowMs,
    claimGeneration(deps, clientId),
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
  const clientId = form.get("client_id") ?? "";
  const grant = "refresh_token";
  if (!verdict.ok) {
    return oauthError("invalid_grant", "The refresh token is not valid", {
      clientId,
      grant,
    });
  }

  const claims: AccessTokenClaims = verdict.claims;
  const seen = deps.generations.get(clientId) ?? 0;
  const generation = claims.gen ?? 0;

  if (generation < seen) {
    // Superseded, which means replayed. Bounded detection, not revocation —
    // this is in memory and a restart forgets it.
    //
    // Kept alongside the `oauth.token_denied` line `oauthError` writes, rather
    // than folded into it: `generation` and `seen` are what make a replay
    // attributable, and the gap between them is what exposed the grant that was
    // minting superseded tokens in the first place.
    logger.warn("oauth.refresh_replayed", { clientId, generation, seen });
    return oauthError(
      "invalid_grant",
      "This refresh token has already been used",
      { clientId, grant },
    );
  }

  logger.info("oauth.token_issued", { clientId, grant });
  // The new refresh token is returned in the same response that supersedes the
  // old one, which is what rotation means for a public client.
  return issue(
    deps.config,
    claims.aud,
    claims.scope.split(" ").filter(Boolean),
    claims.sub,
    nowMs,
    claimGeneration(deps, clientId, generation),
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
    { clientId: form.get("client_id"), grant: grantType },
  );
}
