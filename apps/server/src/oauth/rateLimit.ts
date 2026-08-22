/**
 * Failed-attempt counting for the consent form.
 *
 * `/oauth/authorize` is the one endpoint that accepts a human-chosen secret, so
 * it is the one place where guessing is worth anything. Verifying a passphrase
 * costs ~100 ms of scrypt by design, which already rate-limits an attacker to
 * roughly ten attempts a second per core — this bounds it to something far
 * below that, and bounds the CPU an unauthenticated caller can spend.
 *
 * Bounded and clock-injected: the window reclaims entries on its own, and
 * maxTracked stops a caller who rotates source addresses from turning this
 * into the memory leak it is meant to prevent. When
 * the table is full the oldest entry goes, which is the right failure — an
 * attacker who can spray addresses is not defeated by this anyway, and evicting
 * would-be-blocked entries is better than refusing service to everyone.
 */

export interface RateLimitOptions {
  /** Attempts allowed inside the window before refusing. */
  maxAttempts?: number;
  /** Distinct keys tracked at once. */
  maxTracked?: number;
  now?: () => number;
  windowMs?: number;
}

export interface RateLimiter {
  /** Record a failure. */
  fail(key: string): void;
  /** Whether `key` has spent its attempts. */
  isBlocked(key: string): boolean;
  /** Forget a key. Called on success, so a typo costs nothing lasting. */
  reset(key: string): void;
  readonly size: number;
}

interface Attempts {
  count: number;
  expiresAt: number;
}

export function createRateLimiter({
  maxAttempts = 10,
  maxTracked = 256,
  now = Date.now,
  windowMs = 15 * 60_000,
}: RateLimitOptions = {}): RateLimiter {
  const attempts = new Map<string, Attempts>();

  function live(key: string): Attempts | undefined {
    const entry = attempts.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      attempts.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    fail(key) {
      const entry = live(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      attempts.set(key, { count: 1, expiresAt: now() + windowMs });
      for (const [candidate, value] of attempts) {
        if (value.expiresAt <= now()) attempts.delete(candidate);
      }
      for (const oldest of attempts.keys()) {
        if (attempts.size <= maxTracked) break;
        attempts.delete(oldest);
      }
    },

    isBlocked(key) {
      return (live(key)?.count ?? 0) >= maxAttempts;
    },

    reset(key) {
      attempts.delete(key);
    },

    get size() {
      let count = 0;
      for (const key of [...attempts.keys()]) {
        if (live(key)) count += 1;
      }
      return count;
    },
  };
}
