import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { type AuthServerConfig } from "./metadata";
import { ALL_SCOPES } from "./scopes";

/**
 * RFC 8414 authorization-server metadata for the built-in authorization server.
 *
 * The issuer is a bare origin, which is why this exact path is correct:
 * RFC 8414's path-insertion rule ("insert `/.well-known/...` before the issuer's
 * path component") collapses when there is no path component. `config.ts`
 * rejects a `MCP_PUBLIC_URL` with a path for precisely this reason.
 */

export const AUTHORIZATION_SERVER_PATH =
  "/.well-known/oauth-authorization-server";

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";

/**
 * Requesting a refresh token is what `offline_access` buys, and Claude appends
 * it only when the metadata lists it. Without a refresh token the owner
 * re-consents constantly on iOS.
 */
export const SCOPE_OFFLINE_ACCESS = "offline_access";

/**
 * Only ever called for the built-in authorization server, where `issuer` and
 * `publicOrigin` are the same value. The endpoints are still built from
 * `publicOrigin`, because that is the field that means "a path on this server" —
 * with an external issuer this document is not served at all, and reading
 * `issuer` here would be correct only by coincidence.
 */
export function authorizationServerMetadata(
  config: AuthServerConfig,
): Record<string, unknown> {
  return OAuthMetadataSchema.parse({
    authorization_endpoint: `${config.publicOrigin}${AUTHORIZE_PATH}`,
    // Both of these are what makes Claude choose CIMD over hunting for a
    // `registration_endpoint`. It requires *both*: the flag alone, or `"none"`
    // alone, sends it looking for an endpoint this server deliberately does not
    // have. A test asserts the pair.
    client_id_metadata_document_supported: true,
    // Mandatory. Claude sends `code_challenge_method=S256` on every
    // authorization request regardless of how the client was registered, and
    // the spec says a client MUST refuse to proceed if this is absent.
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: config.issuer,
    response_types_supported: ["code"],
    scopes_supported: [...ALL_SCOPES, SCOPE_OFFLINE_ACCESS],
    token_endpoint: `${config.publicOrigin}${TOKEN_PATH}`,
    token_endpoint_auth_methods_supported: ["none"],
  });
}
