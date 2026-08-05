import { logger } from "../logging";
import {
  type ClientMetadata,
  redirectUriAllowed,
  resolveClient,
} from "./clients";
import { type CodeStore, type PendingAuthorization } from "./codes";
import { isLoopbackOnly, renderConsentPage, renderErrorPage } from "./consent";
import { type AuthServerConfig } from "./metadata";
import { verifyPassphrase } from "./passphrase";
import { type RateLimiter } from "./rateLimit";
import { ALL_SCOPES, parseScopes } from "./scopes";

/**
 * `/oauth/authorize` — the only endpoint a human's browser touches.
 *
 * Two halves. `GET` validates the request and renders a consent page; `POST`
 * checks the passphrase and mints an authorization code. Everything a failure
 * can do depends on whether the `redirect_uri` has been established yet: before
 * that it can only be shown to the person, because redirecting to an unverified
 * URI is the open redirect the verification exists to prevent.
 */

export interface AuthorizeDeps {
  codes: CodeStore;
  config: AuthServerConfig;
  limiter: RateLimiter;
  /** Injected so tests can drive CIMD resolution without the network. */
  resolve?: (clientId: string) => Promise<ClientMetadata | undefined>;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      // The consent page must never be framed: a clickjacked "Allow access"
      // is exactly the attack this page's passphrase is meant to stop.
      "X-Frame-Options": "DENY",
    },
    status,
  });
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state?: string,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state !== undefined) target.searchParams.set("state", state);
  // Deliberately no RFC 9207 `iss` parameter. A self-hosted server reported
  // that adding it correlated with Anthropic's backend ceasing to call /token
  // at all (anthropics/claude-ai-mcp#540). One user's observation rather than a
  // statement from Anthropic — and not worth testing on the owner's connector.
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: target.toString() },
    status: 302,
  });
}

/** The address to rate-limit against, as far as one can be established. */
function callerKey(req: Request): string {
  // Behind Tailscale Funnel there is no client address at all — the header is
  // absent and every attempt shares one bucket, which is the conservative
  // direction (a global cap rather than none).
  //
  // `x-forwarded-for` is trusted only as a bucket label, and a caller who
  // rotates it gets a fresh bucket every request. So this bounds an
  // unsophisticated attacker and nothing more; the real cost of guessing is
  // scrypt's ~36 ms per attempt, not this counter.
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

async function validateRequest(
  params: URLSearchParams,
  deps: AuthorizeDeps,
): Promise<
  | { client: ClientMetadata; ok: true; request: PendingAuthorization }
  | { ok: false; response: Response }
> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";

  if (!clientId || !redirectUri) {
    return {
      ok: false,
      response: html(
        renderErrorPage(
          "Invalid authorization request",
          "The request is missing client_id or redirect_uri, so there is nowhere safe to send you back to.",
        ),
        400,
      ),
    };
  }

  const resolve = deps.resolve ?? resolveClient;
  const client = await resolve(clientId);
  if (!client) {
    return {
      ok: false,
      response: html(
        renderErrorPage(
          "Unknown client",
          `This server could not verify the application at ${clientId}. Its client metadata document was unreachable, malformed, or did not claim that address as its own client_id.`,
        ),
        400,
      ),
    };
  }

  if (!redirectUriAllowed(redirectUri, client)) {
    return {
      ok: false,
      response: html(
        renderErrorPage(
          "Redirect address not registered",
          `${redirectUri} is not one of the addresses this client declares, so this server will not send you there.`,
        ),
        400,
      ),
    };
  }

  // Past this point `redirect_uri` is trusted, so failures go back to the
  // client as RFC 6749 error redirects rather than to the person.
  const state = params.get("state") ?? undefined;

  if (params.get("response_type") !== "code") {
    return {
      ok: false,
      response: redirectWithError(
        redirectUri,
        "unsupported_response_type",
        "Only the authorization code flow is supported",
        state,
      ),
    };
  }

  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge || params.get("code_challenge_method") !== "S256") {
    return {
      ok: false,
      response: redirectWithError(
        redirectUri,
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required",
        state,
      ),
    };
  }

  // An unrecognised scope is dropped rather than refused: Claude appends
  // `offline_access` to obtain a refresh token, and refusing the whole request
  // over a scope this server does not model would break the flow it is for.
  // Refresh tokens are issued unconditionally, so nothing is lost by ignoring it.
  const requested = parseScopes(params.get("scope") ?? undefined);
  const scopes = requested.filter((scope) => ALL_SCOPES.includes(scope));

  return {
    client,
    ok: true,
    request: {
      clientId,
      clientName: client.clientName,
      codeChallenge,
      redirectUri,
      resource: params.get("resource") ?? undefined,
      scopes: scopes.length > 0 ? scopes : [...ALL_SCOPES],
      state,
    },
  };
}

async function handleGet(req: Request, deps: AuthorizeDeps): Promise<Response> {
  const validated = await validateRequest(new URL(req.url).searchParams, deps);
  if (!validated.ok) return validated.response;

  logger.info("oauth.authorize_prompt", {
    clientId: validated.request.clientId,
    scopes: validated.request.scopes,
  });

  return html(
    renderConsentPage({
      csrfToken: deps.codes.remember(validated.request),
      // The URI *this request* will use, not every URI the client declares.
      // A local process that publishes a document listing one hosted address
      // alongside a loopback one, and then asks for the loopback, is exactly
      // the case the warning is for — and passing the declared list means it
      // is the one case that never sees it.
      loopbackOnly: isLoopbackOnly([validated.request.redirectUri]),
      request: validated.request,
    }),
  );
}

async function handlePost(
  req: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  // A cross-site POST cannot carry a valid `request_token`, so CSRF is already
  // covered by the one-time token. This is the cheap second lock: the consent
  // form is same-origin by construction, so any Origin that is not this server
  // is a forgery attempt regardless of what it carries. Scoped to this route —
  // `MCP_ALLOWED_ORIGINS` governs `/mcp` only and is untouched.
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== deps.config.issuer) {
    logger.warn("oauth.consent_bad_origin", { origin });
    return html(
      renderErrorPage(
        "Request refused",
        "This form was submitted from another site.",
      ),
      403,
    );
  }

  // Read as urlencoded text rather than `req.formData()`. The consent form is
  // two text fields, so multipart is never expected — and parsing it would
  // invite a `File` into a code path that only wants strings.
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return html(
      renderErrorPage("Request refused", "The form could not be read."),
      400,
    );
  }

  const requestToken = form.get("request_token") ?? "";
  const pending = deps.codes.recall(requestToken);
  if (!pending) {
    // Also the expiry path: a consent page left open past its TTL.
    return html(
      renderErrorPage(
        "This page has expired",
        "Start the connection again from the application you were signing in from.",
      ),
      400,
    );
  }

  const key = callerKey(req);
  if (deps.limiter.isBlocked(key)) {
    logger.warn("oauth.consent_rate_limited", { key });
    return html(
      renderErrorPage(
        "Too many attempts",
        "Too many incorrect passphrases. Wait a few minutes and start again.",
      ),
      429,
    );
  }

  const passphrase = form.get("passphrase") ?? "";
  if (!verifyPassphrase(passphrase, deps.config.passphraseHash)) {
    deps.limiter.fail(key);
    logger.warn("oauth.consent_failed", { clientId: pending.clientId, key });
    // Re-parked under a fresh token: `recall` is single-use, so the page the
    // owner is looking at has already spent the one it was rendered with.
    return html(
      renderConsentPage({
        csrfToken: deps.codes.remember(pending),
        error: "That passphrase was not correct.",
        // Recomputed, not hardcoded false. The retry page is where the owner
        // actually types the passphrase most of the time, so dropping the
        // impersonation warning here dropped it from the attempt that matters.
        loopbackOnly: isLoopbackOnly([pending.redirectUri]),
        request: pending,
      }),
      401,
    );
  }

  deps.limiter.reset(key);
  const code = deps.codes.issue(pending);
  logger.info("oauth.authorized", {
    clientId: pending.clientId,
    scopes: pending.scopes,
  });

  const target = new URL(pending.redirectUri);
  target.searchParams.set("code", code);
  if (pending.state !== undefined) {
    target.searchParams.set("state", pending.state);
  }
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: target.toString() },
    status: 302,
  });
}

export async function handleAuthorize(
  req: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  if (req.method === "GET") return handleGet(req, deps);
  if (req.method === "POST") return handlePost(req, deps);
  return new Response("Method not allowed", {
    headers: { Allow: "GET, POST" },
    status: 405,
  });
}
