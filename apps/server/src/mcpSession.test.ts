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
  it("does nothing while there is room under the cap", async () => {
    const manager = createSessionManager({ maxSessions: 2 });
    manager.add("a", fakeSession());
    await manager.reserve();
    expect(manager.size).toBe(1);
  });

  it("reclaims idle sessions before touching a live one", async () => {
    // Closing a session whose client has vanished costs nobody anything;
    // closing a live one costs its client a re-handshake. So the sweep runs
    // first and the LRU eviction is the fallback, not the mechanism.
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      maxSessions: 2,
      now: clock.now,
    });
    const abandoned = fakeSession();
    const live = fakeSession();
    manager.add("a", abandoned);
    clock.advance(2_000);
    manager.add("b", live);

    await manager.reserve();
    expect(abandoned.closed).toBe(true);
    expect(live.closed).toBe(false);
    expect(manager.size).toBe(1);
  });

  it("evicts the least recently seen session when every one is active", async () => {
    // The #122 case: Claude opens a session per tool call and never DELETEs,
    // so nothing is sweepable and the cap would otherwise end a working
    // conversation with a 503 whose advised retry is another initialize.
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 10_000,
      maxSessions: 2,
      now: clock.now,
    });
    const oldest = fakeSession();
    const newer = fakeSession();
    manager.add("a", oldest);
    clock.advance(1_000);
    manager.add("b", newer);

    await manager.reserve();
    expect(oldest.closed).toBe(true);
    expect(newer.closed).toBe(false);
    expect(manager.get("a")).toBeUndefined();
    expect(manager.size).toBe(1);
  });

  it("counts a request as recency, not just when the session was opened", async () => {
    // Otherwise the oldest *session* is evicted rather than the quietest one,
    // and the session doing the work is the one that gets closed.
    const clock = fakeClock();
    const manager = createSessionManager({
      idleTimeoutMs: 10_000,
      maxSessions: 2,
      now: clock.now,
    });
    const busy = fakeSession();
    const quiet = fakeSession();
    manager.add("a", busy);
    clock.advance(1_000);
    manager.add("b", quiet);
    clock.advance(1_000);
    manager.get("a");

    await manager.reserve();
    expect(quiet.closed).toBe(true);
    expect(busy.closed).toBe(false);
  });

  it("frees enough slots when the map is already over the cap", async () => {
    // A cap lowered between restarts leaves the map above the new ceiling, and
    // a single eviction would not be enough to admit anyone. Nothing here is
    // idle — the default TTL is 30 minutes and the clock has barely moved — so
    // the loop, not the sweep, is what has to close all three.
    const clock = fakeClock();
    const manager = createSessionManager({ maxSessions: 1, now: clock.now });
    for (const id of ["a", "b", "c"]) {
      manager.add(id, fakeSession());
      clock.advance(1);
    }

    await manager.reserve();
    expect(manager.size).toBe(0);
  });

  it("clamps a zero cap rather than becoming unable to admit anyone", async () => {
    // `reserve()` promises to always succeed, and a cap of zero is the one
    // value that could break that promise. It is also not a configuration
    // anyone wants — it means "serve nobody".
    const manager = createSessionManager({ maxSessions: 0 });
    await manager.reserve();
    manager.add("a", fakeSession());
    expect(manager.size).toBe(1);
    await manager.reserve();
    expect(manager.size).toBe(0);
  });

  it("reports why each session was closed", async () => {
    // A run of `capacity` evictions is the signature of a host that is not
    // reusing its sessions; `idle` is a client that went away. Same callback,
    // different diagnosis, so the reason has to survive to the log.
    const clock = fakeClock();
    const reasons: Array<[string, string]> = [];
    const manager = createSessionManager({
      idleTimeoutMs: 1_000,
      maxSessions: 1,
      now: clock.now,
      onEvicted: (sessionId, reason) => reasons.push([sessionId, reason]),
    });

    manager.add("gone", fakeSession());
    clock.advance(2_000);
    await manager.reserve();

    manager.add("live", fakeSession());
    await manager.reserve();

    expect(reasons).toEqual([
      ["gone", "idle"],
      ["live", "capacity"],
    ]);
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
