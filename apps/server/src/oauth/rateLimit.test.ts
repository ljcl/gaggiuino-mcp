import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit";

/**
 * The clock is injected rather than faked globally, so the window boundary is
 * asserted exactly: a key is live while `expiresAt > now()`, which puts the
 * last millisecond of the window inside it and the window's own instant out.
 */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    advance(ms: number) {
      current += ms;
    },
    now: () => current,
  };
}

describe("counting failures", () => {
  it("does not block a caller that has never failed", () => {
    const limiter = createRateLimiter({ maxAttempts: 3 });
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    expect(limiter.size).toBe(0);
  });

  it("blocks a caller only once it has spent every attempt", () => {
    const limiter = createRateLimiter({ maxAttempts: 3 });

    limiter.fail("1.2.3.4");
    limiter.fail("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);

    limiter.fail("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);
  });

  it("counts each caller against its own budget", () => {
    const limiter = createRateLimiter({ maxAttempts: 2 });
    limiter.fail("a");
    limiter.fail("a");
    limiter.fail("b");

    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
    expect(limiter.size).toBe(2);
  });

  it("measures the window from the first failure, not the latest", () => {
    // A window that slid forward on every failure would let a caller who keeps
    // guessing hold its own entry — and its own block — open indefinitely.
    const clock = fakeClock();
    const limiter = createRateLimiter({
      maxAttempts: 3,
      now: clock.now,
      windowMs: 10_000,
    });

    limiter.fail("a");
    clock.advance(9_999);
    limiter.fail("a");
    limiter.fail("a");
    expect(limiter.isBlocked("a")).toBe(true);

    clock.advance(1);
    expect(limiter.isBlocked("a")).toBe(false);
  });
});

describe("the window", () => {
  it("frees a blocked caller the moment its window closes", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      maxAttempts: 2,
      now: clock.now,
      windowMs: 60_000,
    });

    limiter.fail("a");
    limiter.fail("a");
    clock.advance(59_999);
    expect(limiter.isBlocked("a")).toBe(true);

    clock.advance(1);
    expect(limiter.isBlocked("a")).toBe(false);
  });

  it("gives a caller a fresh count once its window has closed", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      maxAttempts: 2,
      now: clock.now,
      windowMs: 60_000,
    });

    limiter.fail("a");
    limiter.fail("a");
    clock.advance(60_000);
    limiter.fail("a");

    expect(limiter.isBlocked("a")).toBe(false);
  });

  it("excludes keys whose window has closed from its size", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      maxAttempts: 5,
      now: clock.now,
      windowMs: 60_000,
    });

    limiter.fail("early");
    clock.advance(30_000);
    limiter.fail("late");
    clock.advance(30_000);

    expect(limiter.size).toBe(1);
  });
});

describe("reset", () => {
  it("frees a blocked caller straight away", () => {
    // Called on a successful passphrase, so an owner who mistyped theirs a few
    // times is not left waiting out a window they have already disproved.
    const limiter = createRateLimiter({ maxAttempts: 2 });
    limiter.fail("a");
    limiter.fail("a");

    limiter.reset("a");

    expect(limiter.isBlocked("a")).toBe(false);
    expect(limiter.size).toBe(0);
  });

  it("forgets only the key it is given", () => {
    const limiter = createRateLimiter({ maxAttempts: 1 });
    limiter.fail("a");
    limiter.fail("b");

    limiter.reset("a");

    expect(limiter.isBlocked("a")).toBe(false);
    expect(limiter.isBlocked("b")).toBe(true);
  });

  it("is harmless on a key it has never seen", () => {
    const limiter = createRateLimiter({ maxAttempts: 1 });
    limiter.fail("a");

    limiter.reset("never-failed");

    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.size).toBe(1);
  });
});

describe("capacity", () => {
  it("drops the oldest key when the table is full", () => {
    // The documented trade: a caller spraying addresses evicts its own
    // would-be-blocked entries rather than crowding everyone else out.
    const limiter = createRateLimiter({ maxAttempts: 1, maxTracked: 2 });
    limiter.fail("a");
    limiter.fail("b");
    limiter.fail("c");

    expect(limiter.isBlocked("a")).toBe(false);
    expect(limiter.isBlocked("b")).toBe(true);
    expect(limiter.isBlocked("c")).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it("never tracks more keys than the cap", () => {
    const limiter = createRateLimiter({ maxAttempts: 1, maxTracked: 3 });
    for (let i = 0; i < 50; i += 1) limiter.fail(`10.0.0.${i}`);
    expect(limiter.size).toBe(3);
  });

  it("keeps counting a tracked key without spending cap on it", () => {
    const limiter = createRateLimiter({ maxAttempts: 3, maxTracked: 2 });
    limiter.fail("a");
    limiter.fail("a");
    limiter.fail("b");
    limiter.fail("a");

    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
    expect(limiter.size).toBe(2);
  });

  it("reclaims keys whose window has closed when a new key fails", () => {
    // Entries the window has already released must not sit on slots the cap
    // would otherwise give a real caller.
    const clock = fakeClock();
    const limiter = createRateLimiter({
      maxAttempts: 5,
      maxTracked: 8,
      now: clock.now,
      windowMs: 60_000,
    });

    limiter.fail("a");
    limiter.fail("b");
    clock.advance(60_000);
    limiter.fail("c");

    expect(limiter.size).toBe(1);
  });
});

describe("defaults", () => {
  it("allows ten attempts before blocking", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 9; i += 1) limiter.fail("a");
    expect(limiter.isBlocked("a")).toBe(false);

    limiter.fail("a");
    expect(limiter.isBlocked("a")).toBe(true);
  });

  it("holds a block for fifteen minutes", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    for (let i = 0; i < 10; i += 1) limiter.fail("a");

    clock.advance(15 * 60_000 - 1);
    expect(limiter.isBlocked("a")).toBe(true);

    clock.advance(1);
    expect(limiter.isBlocked("a")).toBe(false);
  });

  it("tracks 256 keys at once", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 300; i += 1) limiter.fail(`caller-${i}`);
    expect(limiter.size).toBe(256);
  });
});
