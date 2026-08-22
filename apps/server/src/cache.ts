/**
 * A bounded TTL cache with LRU eviction.
 *
 * It exists for one upstream: an ESP32 on Wi-Fi that answers a single request
 * at a time, and completed shots that are immutable — rendering one graph
 * legitimately needs the same finished shot several times (tool summary, then
 * the app's raw JSON, then comparison overlays), which is what folding repeats
 * buys.
 *
 * Two bounds rather than one, because they fail differently. The TTL is what
 * makes a cached answer honest: past it, the value is re-read even if nothing
 * has evicted it. `maxEntries` is what keeps a long-lived server from holding
 * every shot it has ever been asked about — a shot payload is hundreds of
 * datapoints, and nothing else in this process would ever free them.
 *
 * The clock is injected so the expiry tests assert "eleven minutes later"
 * without waiting eleven minutes, or eleven milliseconds.
 */
export interface CacheOptions {
  /** Hard cap on live entries; the least recently used is evicted past it. */
  maxEntries: number;
  now?: () => number;
}

export interface TtlCache<T> {
  clear(): void;
  /**
   * Drop one key, if it is there.
   *
   * The TTL answers "has this gone stale on its own"; this answers "we just
   * changed the thing it describes". A write this server performs is the one
   * case the TTL cannot cover, because the staleness starts the moment the
   * write lands rather than at some point in the next thirty seconds.
   */
  delete(key: string): void;
  /** The live value for `key`, or `undefined` when absent or expired. */
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs: number): void;
  /** Live entries, expired ones excluded. Test and diagnostic use. */
  readonly size: number;
}

interface Entry<T> {
  expiresAt: number;
  value: T;
}

export function createCache<T>({
  maxEntries,
  now = Date.now,
}: CacheOptions): TtlCache<T> {
  if (maxEntries < 1) {
    throw new Error(`Cache maxEntries must be at least 1, got ${maxEntries}`);
  }

  // A Map iterates in insertion order, which is the whole LRU implementation:
  // a read re-inserts at the back, so the front is always the coldest entry.
  const entries = new Map<string, Entry<T>>();

  function live(key: string): Entry<T> | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    clear() {
      entries.clear();
    },

    delete(key) {
      entries.delete(key);
    },

    get(key) {
      const entry = live(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value, ttlMs) {
      // Delete first so a re-set moves the key to the back rather than
      // updating it in place at its original, possibly coldest, position.
      entries.delete(key);
      entries.set(key, { expiresAt: now() + ttlMs, value });

      // Expired entries are dead weight the cap should not have to spend an
      // eviction on, so they go before anything live does.
      if (entries.size > maxEntries) {
        for (const [candidate, entry] of entries) {
          if (entry.expiresAt <= now()) entries.delete(candidate);
        }
      }
      // Iteration order is coldest-first, and deleting the key the iterator is
      // sitting on is well defined for a Map, so this walks forward from the
      // front until the cap is met.
      for (const coldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(coldest);
      }
    },

    get size() {
      let count = 0;
      for (const key of [...entries.keys()]) {
        if (live(key)) count += 1;
      }
      return count;
    },
  };
}
