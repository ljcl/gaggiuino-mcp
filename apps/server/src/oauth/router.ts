import { type AuthorizeDeps, handleAuthorize } from "./authorize";
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  authorizationServerMetadata,
  TOKEN_PATH,
} from "./authServer";
import { createCodeStore } from "./codes";
import {
  type AuthServerConfig,
  handleMetadataRequest,
  type OAuthConfig,
} from "./metadata";
import { createRateLimiter } from "./rateLimit";
import { handleToken } from "./token";

/**
 * Everything served on this server's own OAuth surface, in one router.
 *
 * A factory rather than module-level state, so the authorization codes, the
 * failed-attempt counters and the refresh generations belong to a handler
 * instead of a process. That is what lets a test build two servers without one
 * seeing the other's codes — and it costs nothing in production, where there is
 * exactly one handler.
 */

export interface OAuthRouter {
  /** Answer an OAuth or discovery request, or `undefined` if it is neither. */
  handle(
    req: Request,
    pathname: string,
  ): Promise<Response> | Response | undefined;
}

export interface OAuthRouterOptions {
  config: OAuthConfig;
  /** Test seam for CIMD resolution, threaded through to `handleAuthorize`. */
  resolve?: AuthorizeDeps["resolve"];
}

/**
 * Whether this configuration can run the built-in authorization server.
 *
 * An external issuer takes precedence and is checked first: `MCP_OAUTH_ISSUER`
 * puts this server in resource-server-only mode, where `/oauth/*` and
 * `/.well-known/oauth-authorization-server` must not mount at all. Serving an
 * authorization endpoint while advertising somebody else's would give a client
 * two answers to the same question.
 *
 * `loadOAuthConfig` already refuses the combination at startup, so this is the
 * second of two locks rather than the only one.
 */
function asAuthServer(config: OAuthConfig): AuthServerConfig | undefined {
  return config.external ? undefined : config;
}

export function createOAuthRouter({
  config,
  resolve,
}: OAuthRouterOptions): OAuthRouter {
  const codes = createCodeStore();
  const limiter = createRateLimiter();
  const generations = new Map<string, number>();
  const authServer = asAuthServer(config);

  return {
    handle(req, pathname) {
      // Protected-resource metadata is served whether or not this server is
      // also the authorization server — with an external issuer it is the only
      // document this server publishes, and `authorization_servers` points at
      // the IdP instead of here.
      const prm = handleMetadataRequest(pathname, config);
      if (prm) return prm;

      if (!authServer) return undefined;

      if (pathname === AUTHORIZATION_SERVER_PATH) {
        return Response.json(authorizationServerMetadata(authServer), {
          headers: { "Cache-Control": "public, max-age=300" },
        });
      }
      if (pathname === AUTHORIZE_PATH) {
        return handleAuthorize(req, {
          codes,
          config: authServer,
          limiter,
          resolve,
        });
      }
      if (pathname === TOKEN_PATH) {
        return handleToken(req, { codes, config: authServer, generations });
      }
      return undefined;
    },
  };
}
