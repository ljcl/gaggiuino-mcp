/**
 * The two scopes this resource server understands.
 *
 * They map onto the split the tool annotations already declare: everything with
 * `readOnlyHint: true` needs `espresso:read`, and the three tools that change
 * the machine need `espresso:write`. Nothing here enumerates tools — the
 * protected set is derived from the annotations themselves (see
 * `PROTECTED_TOOLS` in `oauth/scopeGate.ts`), so a new write tool inherits the
 * gate rather than being forgotten.
 */

export const SCOPE_READ = "espresso:read";
export const SCOPE_WRITE = "espresso:write";

export const ALL_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

/**
 * Every scope, space-delimited, for the `scope` parameter of a
 * `WWW-Authenticate` challenge.
 *
 * Both scopes are named on an `insufficient_scope` refusal, never just the
 * missing one. Anthropic's lazy-authentication guidance is explicit that
 * "scopes the user picked up in an earlier step-up aren't reliably carried
 * forward into the next one," so returning only the missing scope loses the one
 * the caller already had. The value is cached per user per server for about
 * fifteen minutes, which makes an under-broad challenge expensive to correct.
 */
export const ALL_SCOPES_HEADER = ALL_SCOPES.join(" ");

/** Split an OAuth `scope` claim, which is space-delimited by RFC 6749. */
export function parseScopes(claim: string | undefined): string[] {
  if (!claim) return [];
  return claim.split(/\s+/).filter((scope) => scope.length > 0);
}
