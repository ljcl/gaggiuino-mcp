import { describe, expect, it, vi } from "vitest";
import { type ClosableSession, createSessionManager } from "./mcpSession";

/**
 * The clock is injected rather than faked globally so expiry is asserted by
 * moving time forward explicitly — no timers, no waiting, and the assertions
 * read as "after 31 minutes of silence" rather than "after a tick".
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

function fakeSession(): ClosableSession & { closed: boolean } {
  const session = {
    closed: false,
    close: async () => {
      session.closed = true;
    },
  };
  return session;
}

describe("lookup", () => {
  it("returns undefined for an unknown session", () => {
    const manager = createSessionManager();
    expect(manager.get("nope")).toBeUndefined();
  });

  it("returns a registered session and counts it", () => {
    const manager = createSessionManager();
    const session = fakeSession();
    manager.add("a", session);
    expect(manager.get("a")).toBe(session);
    expect(manager.size).toBe(1);
  });

  it("forgets a session without closing it", async () => {
    // This is the path the transport's own `onclose` takes: the transport is
    // already closing itself, so closing it again here would recurse.
    const manager = createSessionManager();
    const session = fakeSession();
    manager.add("a", session);
    manager.delete("a");
    expect(manager.size).toBe(0);
    expect(session.closed).toBe(false);
  });
});

describe("idle expiry", () => {
  it("closes a session that has gone quiet past the TTL", async () => {
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 30 * 60 * 1000,
      now: clock.now,
    });
    const session = fakeSession();
    manager.add("a", session);

    clock.advance(29 * 60 * 1000);
    expect(await manager.sweep()).toEqual([]);
    expect(manager.size).toBe(1);

    clock.advance(2 * 60 * 1000);
    expect(await manager.sweep()).toEqual(["a"]);
    expect(manager.size).toBe(0);
    expect(session.closed).toBe(true);
  });

  it("keeps a session alive as long as requests keep arriving", async () => {
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 10_000,
      now: clock.now,
    });
    manager.add("a", fakeSession());

    for (let i = 0; i < 5; i += 1) {
      clock.advance(9_000);
      expect(manager.get("a")).toBeDefined();
      expect(await manager.sweep()).toEqual([]);
    }
    expect(manager.size).toBe(1);
  });

  it("reports every eviction it makes", async () => {
    const clock = fakeClock();
    const onEvicted = vi.fn();
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      now: clock.now,
      onEvicted,
    });
    manager.add("a", fakeSession());
    clock.advance(2_000);
    await manager.sweep();
    expect(onEvicted).toHaveBeenCalledWith("a", "idle");
  });

  it("finishes the sweep when one session refuses to close", async () => {
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      now: clock.now,
    });
    const healthy = fakeSession();
    manager.add("broken", {
      close: async () => {
        throw new Error("transport already destroyed");
      },
    });
    manager.add("healthy", healthy);

    clock.advance(2_000);
    await expect(manager.sweep()).resolves.toEqual(["broken", "healthy"]);
    expect(healthy.closed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("survives a session that deletes itself from its own close()", async () => {
    // The real transport's `onclose` calls back into `delete`, so `sweep` is
    // mutating the map it is iterating unless it removes the entry first.
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      now: clock.now,
    });
    manager.add("a", {
      close: async () => {
        manager.delete("a");
      },
    });
    manager.add("b", fakeSession());

    clock.advance(2_000);
    expect(await manager.sweep()).toEqual(["a", "b"]);
    expect(manager.size).toBe(0);
  });
});

describe("capacity", () => {
  it("admits sessions up to the cap", async () => {
    const manager = createSessionManager({ maxSessions: 2 });
    expect(await manager.tryReserve()).toBe(true);
    manager.add("a", fakeSession());
    expect(await manager.tryReserve()).toBe(true);
    manager.add("b", fakeSession());
    expect(await manager.tryReserve()).toBe(false);
  });

  it("reclaims idle sessions before refusing a new one", async () => {
    // A burst of abandoned sessions must not lock out a client that arrives
    // later, which is the whole reason tryReserve sweeps instead of just
    // comparing against the cap.
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      maxSessions: 2,
      now: clock.now,
    });
    const abandoned = fakeSession();
    manager.add("a", abandoned);
    manager.add("b", fakeSession());
    expect(await manager.tryReserve()).toBe(false);

    clock.advance(2_000);
    expect(await manager.tryReserve()).toBe(true);
    expect(abandoned.closed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("still refuses when every session is active", async () => {
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 10_000,
      maxSessions: 1,
      now: clock.now,
    });
    manager.add("a", fakeSession());
    clock.advance(5_000);
    manager.get("a");
    expect(await manager.tryReserve()).toBe(false);
    expect(manager.size).toBe(1);
  });
});

describe("closeAll", () => {
  it("closes every session and empties the registry", async () => {
    const manager = createSessionManager();
    const first = fakeSession();
    const second = fakeSession();
    manager.add("a", first);
    manager.add("b", second);

    await manager.closeAll();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("drains the rest when one session throws on close", async () => {
    const manager = createSessionManager();
    const healthy = fakeSession();
    manager.add("broken", {
      close: async () => {
        throw new Error("no");
      },
    });
    manager.add("healthy", healthy);

    await expect(manager.closeAll()).resolves.toBeUndefined();
    expect(healthy.closed).toBe(true);
  });
});

describe("reaper", () => {
  it("sweeps on its interval and stops when told to", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const manager = createSessionManager({
        idleTimeoutMs: 1_000,
        now: clock.now,
        sweepIntervalMs: 500,
      });
      const session = fakeSession();
      manager.add("a", session);
      const stop = manager.startReaper();

      clock.advance(2_000);
      await vi.advanceTimersByTimeAsync(500);
      expect(session.closed).toBe(true);

      const second = fakeSession();
      manager.add("b", second);
      stop();
      clock.advance(2_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(second.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
