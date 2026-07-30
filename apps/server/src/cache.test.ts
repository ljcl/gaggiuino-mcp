import { describe, expect, it } from "vitest";
import { createCache } from "./cache";

/**
 * The clock is injected, so every expiry assertion here is instant and exact —
 * no `await sleep(1)` hoping the timer fired, and no test that gets slower as
 * the TTLs get more realistic.
 */
function fakeClock(start = 0) {
  let current = start;
  return {
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe("createCache", () => {
  it("returns a value it was given", () => {
    const cache = createCache<string>({ maxEntries: 4 });
    cache.set("a", "one", 1000);
    expect(cache.get("a")).toBe("one");
  });

  it("misses on a key it has never seen", () => {
    const cache = createCache<string>({ maxEntries: 4 });
    expect(cache.get("nothing")).toBeUndefined();
  });

  it("expires an entry once its ttl has passed", () => {
    const clock = fakeClock();
    const cache = createCache<string>({ maxEntries: 4, now: clock.now });

    cache.set("shot", "payload", 60_000);
    clock.advance(59_999);
    expect(cache.get("shot")).toBe("payload");

    clock.advance(1);
    expect(cache.get("shot")).toBeUndefined();
  });

  it("expires each key on its own ttl", () => {
    const clock = fakeClock();
    const cache = createCache<string>({ maxEntries: 4, now: clock.now });

    cache.set("brief", "latest-id", 5_000);
    cache.set("long", "shot", 600_000);
    clock.advance(10_000);

    expect(cache.get("brief")).toBeUndefined();
    expect(cache.get("long")).toBe("shot");
  });

  it("re-setting a key restarts its ttl", () => {
    const clock = fakeClock();
    const cache = createCache<string>({ maxEntries: 4, now: clock.now });

    cache.set("a", "first", 1_000);
    clock.advance(900);
    cache.set("a", "second", 1_000);
    clock.advance(900);

    expect(cache.get("a")).toBe("second");
  });

  it("evicts the least recently used entry past the cap", () => {
    const cache = createCache<string>({ maxEntries: 2 });
    cache.set("a", "1", 60_000);
    cache.set("b", "2", 60_000);
    cache.set("c", "3", 60_000);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("counts a read as recent use", () => {
    const cache = createCache<string>({ maxEntries: 2 });
    cache.set("a", "1", 60_000);
    cache.set("b", "2", 60_000);
    cache.get("a");
    cache.set("c", "3", 60_000);

    // "b" is now the coldest, not "a", because "a" was read in between.
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  it("spends the cap on expired entries before live ones", () => {
    const clock = fakeClock();
    const cache = createCache<string>({ maxEntries: 2, now: clock.now });

    cache.set("stale", "1", 1_000);
    cache.set("fresh", "2", 600_000);
    clock.advance(2_000);
    cache.set("new", "3", 600_000);

    expect(cache.get("fresh")).toBe("2");
    expect(cache.get("new")).toBe("3");
  });

  it("never holds more than the cap", () => {
    const cache = createCache<number>({ maxEntries: 3 });
    for (let i = 0; i < 50; i += 1) cache.set(`k${i}`, i, 60_000);
    expect(cache.size).toBe(3);
  });

  it("excludes expired entries from its size", () => {
    const clock = fakeClock();
    const cache = createCache<string>({ maxEntries: 8, now: clock.now });

    cache.set("a", "1", 1_000);
    cache.set("b", "2", 600_000);
    clock.advance(2_000);

    expect(cache.size).toBe(1);
  });

  it("drops everything on clear", () => {
    const cache = createCache<string>({ maxEntries: 4 });
    cache.set("a", "1", 60_000);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("refuses a cap it could not honour", () => {
    expect(() => createCache<string>({ maxEntries: 0 })).toThrow(/at least 1/);
  });
});
