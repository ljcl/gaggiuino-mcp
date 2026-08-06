import { randomBytes } from "node:crypto";

/**
 * Authorization codes, and the pending requests a consent page is rendered for.
 *
 * Both are in-memory and short-lived by design. A restart drops them, and that
 * is fine: an authorization code is worth at most sixty seconds and a consent
 * page the owner has open is worth one page reload. Nothing here is the thing
 * that keeps somebody signed in — that is the refresh token, which is stateless
 * and survives restarts precisely so this does not have to.
 *
 * Bounded as well as expiring, for the same reason `mcpSession.ts` is: the TTL
 * reclaims entries whose flow was abandoned, and the cap bounds anything that
 * outruns it. The clock is injected so the expiry tests assert "sixty-one
 * seconds later" without waiting.
 */

/** RFC 6749 §4.1.2 recommends a maximum of ten minutes; sixty seconds is ample
 *  for a redirect the browser performs immediately. */
const CODE_TTL_MS = 60_000;

/** A consent page the owner may sit on for a while before submitting. */
const PENDING_TTL_MS = 10 * 60_000;

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
  /** Park a validated authorization request while the owner is asked. */
  remember(request: PendingAuthorization): string;
  /** Recall a parked request by its CSRF token. Single-use, like a code. */
  recall(token: string): PendingAuthorization | undefined;
  readonly size: number;
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createCodeStore({
  now = Date.now,
}: CodeStoreOptions = {}): CodeStore {
  const codes = new Map<string, IssuedCode>();
  const pending = new Map<string, IssuedCode>();

  function sweep(store: Map<string, IssuedCode>): void {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now()) store.delete(key);
    }
    // Insertion order is oldest-first, so this drops the coldest entries.
    for (const key of store.keys()) {
      if (store.size <= MAX_ENTRIES) break;
      store.delete(key);
    }
  }

  function put(
    store: Map<string, IssuedCode>,
    request: PendingAuthorization,
    ttlMs: number,
  ): string {
    const key = newSecret();
    store.set(key, { ...request, expiresAt: now() + ttlMs });
    sweep(store);
    return key;
  }

  function take(
    store: Map<string, IssuedCode>,
    key: string,
  ): IssuedCode | undefined {
    const entry = store.get(key);
    // Deleted whether or not it was still live: a code is one-time even when
    // the attempt that presents it fails.
    store.delete(key);
    if (!entry) return undefined;
    return entry.expiresAt <= now() ? undefined : entry;
  }

  return {
    issue: (request) => put(codes, request, CODE_TTL_MS),
    recall: (token) => take(pending, token),
    redeem: (code) => take(codes, code),
    remember: (request) => put(pending, request, PENDING_TTL_MS),
    get size() {
      return codes.size + pending.size;
    },
  };
}
