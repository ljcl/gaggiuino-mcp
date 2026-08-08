import { randomBytes } from "node:crypto";

/**
 * Authorization codes: the one thing standing between a granted consent page and
 * a token.
 *
 * In-memory and short-lived by design. A restart drops them, and that is fine:
 * an authorization code is worth at most sixty seconds. Nothing here is what
 * keeps somebody signed in — that is the refresh token, which is stateless and
 * survives restarts precisely so this does not have to.
 *
 * Bounded as well as expiring, for the same reason `mcpSession.ts` is: the TTL
 * reclaims entries whose flow was abandoned, and the cap bounds anything that
 * outruns it. The clock is injected so the expiry tests assert "sixty-one
 * seconds later" without waiting.
 *
 * The consent page's `request_token` used to be parked here too, in a second map
 * behind the same cap. It is a signed, stateless token now (`signConsentToken`
 * in `tokens.ts`) because that map was the one store an *unauthenticated* caller
 * could fill — `GET /oauth/authorize` parked an entry before any passphrase was
 * checked (#119). Filling this map requires the passphrase, so the same flood
 * does not reach it.
 */

/** RFC 6749 §4.1.2 recommends a maximum of ten minutes; sixty seconds is ample
 *  for a redirect the browser performs immediately. */
const CODE_TTL_MS = 60_000;

const MAX_ENTRIES = 64;

/** What an authorization request asked for, carried through the consent page. */
export interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  codeChallenge: string;
  redirectUri: string;
  /** RFC 8707 resource indicator, echoed into the token's `aud`. */
  resource?: string;
  scopes: string[];
  state?: string;
}

/** An issued code, bound to everything the token endpoint must re-check. */
export interface IssuedCode extends PendingAuthorization {
  expiresAt: number;
}

export interface CodeStoreOptions {
  now?: () => number;
}

export interface CodeStore {
  /** Mint a one-time authorization code for a granted request. */
  issue(request: PendingAuthorization): string;
  /**
   * Redeem a code, or `undefined` if it is unknown, expired or already used.
   *
   * Deletion happens on the way out whatever the outcome, which is what makes a
   * code single-use: a replayed code finds nothing, and PKCE is checked by the
   * caller against what this returns rather than being trusted to have been
   * checked earlier.
   */
  redeem(code: string): IssuedCode | undefined;
  readonly size: number;
}

export function createCodeStore({
  now = Date.now,
}: CodeStoreOptions = {}): CodeStore {
  const codes = new Map<string, IssuedCode>();

  function sweep(): void {
    for (const [key, entry] of codes) {
      if (entry.expiresAt <= now()) codes.delete(key);
    }
    // Insertion order is oldest-first, so this drops the coldest entries.
    for (const key of codes.keys()) {
      if (codes.size <= MAX_ENTRIES) break;
      codes.delete(key);
    }
  }

  return {
    issue(request) {
      // 32 bytes of randomness: a code is a bearer credential for the whole
      // grant, so a short or predictable one is the entire attack.
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { ...request, expiresAt: now() + CODE_TTL_MS });
      sweep();
      return code;
    },
    redeem(code) {
      const entry = codes.get(code);
      // Deleted whether or not it was still live: a code is one-time even when
      // the attempt that presents it fails.
      codes.delete(code);
      if (!entry) return undefined;
      return entry.expiresAt <= now() ? undefined : entry;
    },
    get size() {
      return codes.size;
    },
  };
}
