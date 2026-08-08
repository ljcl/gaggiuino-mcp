/**
 * Bounded, expiring registry of live MCP transports.
 *
 * Every `initialize` POST allocates a transport and an MCP server, and the only
 * thing that used to remove one was the transport's own `onclose` — which fires
 * on an explicit DELETE. Clients that vanish without one (a tunnel drops, a
 * host restarts, a laptop sleeps) leaked their session forever, and nothing
 * capped how many could accumulate.
 *
 * Two mechanisms, because they fail differently: an idle TTL reclaims sessions
 * whose client is gone, and a hard cap bounds the damage from anything that
 * outruns the TTL.
 *
 * **The cap evicts rather than refuses, and that is not a detail.** Claude
 * opens a fresh session per tool call and never sends a DELETE — five
 * `session.opened` records in forty seconds, no `session.closed` between them,
 * observed on the real deployment. Nothing that arrived inside the TTL is
 * sweepable, so refusing at the cap meant roughly 64 tool calls in half an hour
 * ended a working conversation with a 503, and the advice that 503 carried —
 * "retry shortly" — is another `initialize`, which is the thing that filled the
 * map. See #122.
 *
 * Eviction makes the cap a bound on *memory* instead of a bound on conversation
 * length, and the two failure modes are not comparable. An evicted client's
 * next request 404s, which is the Streamable HTTP spec's own signal to
 * re-handshake — a path this server already implements and a client already
 * recovers from. A 503 on `initialize` has no such recovery. So `reserve()`
 * always succeeds.
 *
 * It still sweeps first: reclaiming a session whose client is genuinely gone is
 * always better than closing one that is merely oldest.
 */

/** The slice of the transport this module needs; keeps tests free of real transports. */
export interface ClosableSession {
  close(): Promise<void>;
}

export interface SessionManagerOptions {
  /** Reclaim a session after this long with no request. Default 30 minutes. */
  idleTimeoutMs?: number;
  /**
   * Hard ceiling on concurrent sessions. Default 64.
   *
   * Clamped to at least 1. A cap of zero would mean "serve nobody", which is
   * not a configuration anyone wants and is the only value that could make
   * `reserve()` unable to free a slot — clamping keeps that guarantee total
   * rather than leaving a degenerate branch nothing exercises.
   */
  maxSessions?: number;
  /** Injectable clock. Tests drive expiry without waiting for it. */
  now?: () => number;
  /**
   * Called with the id of every session the manager closes on its own.
   *
   * `idle` means the client had gone quiet past the TTL. `capacity` means the
   * session was live and simply the least recently seen when a new one needed
   * room — worth distinguishing in the log, because a run of `capacity`
   * evictions is the signature of a host that is not reusing its sessions.
   */
  onEvicted?: (sessionId: string, reason: "idle" | "capacity") => void;
  /** How often the reaper runs once started. Default 60 seconds. */
  sweepIntervalMs?: number;
}

export interface SessionManager<T extends ClosableSession> {
  /** Register a new session. Callers must have reserved capacity first. */
  add(sessionId: string, session: T): void;
  /** Close and forget every session. Used on shutdown. */
  closeAll(): Promise<void>;
  /** Forget a session without closing it — for the transport's own onclose. */
  delete(sessionId: string): void;
  /** Look up a session, marking it active. Returns undefined if unknown. */
  get(sessionId: string): T | undefined;
  readonly size: number;
  /** Start the background reaper. Returns a function that stops it. */
  startReaper(): () => void;
  /** Close every session idle beyond the TTL. Returns the ids closed. */
  sweep(): Promise<string[]>;
  /**
   * Make room for one more session, closing whatever it takes. Always
   * succeeds, so callers have no failure to handle.
   */
  reserve(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export function createSessionManager<T extends ClosableSession>(
  options: SessionManagerOptions = {},
): SessionManager<T> {
  const {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    now = Date.now,
    onEvicted,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  } = options;

  const cap = Math.max(1, maxSessions);

  const sessions = new Map<string, { lastSeen: number; session: T }>();

  async function evict(
    sessionId: string,
    reason: "idle" | "capacity",
  ): Promise<void> {
    const entry = sessions.get(sessionId);
    // Delete before closing: `close()` fires the transport's `onclose`, which
    // calls back into `delete`. Removing the entry first keeps that reentrant
    // path a no-op instead of a second pass over a mutating map.
    sessions.delete(sessionId);
    onEvicted?.(sessionId, reason);
    // One session refusing to close must not strand the rest of the caller.
    await entry?.session.close().catch(() => {});
  }

  async function sweep(): Promise<string[]> {
    const deadline = now() - idleTimeoutMs;
    const expired = [...sessions.entries()]
      .filter(([, entry]) => entry.lastSeen <= deadline)
      .map(([sessionId]) => sessionId);

    for (const sessionId of expired) await evict(sessionId, "idle");
    return expired;
  }

  /** Every session id, quietest first. A snapshot: eviction mutates the map. */
  function byRecency(): string[] {
    return [...sessions.entries()]
      .sort(([, a], [, b]) => a.lastSeen - b.lastSeen)
      .map(([sessionId]) => sessionId);
  }

  return {
    add(sessionId, session) {
      sessions.set(sessionId, { lastSeen: now(), session });
    },

    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map((entry) => entry.session.close().catch(() => {})),
      );
    },

    delete(sessionId) {
      sessions.delete(sessionId);
    },

    get(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return undefined;
      entry.lastSeen = now();
      return entry.session;
    },

    get size() {
      return sessions.size;
    },

    startReaper() {
      const timer = setInterval(() => {
        void sweep();
      }, sweepIntervalMs);
      // Never hold the process open for the reaper alone.
      timer.unref?.();
      return () => clearInterval(timer);
    },

    sweep,

    async reserve() {
      if (sessions.size < cap) return;

      // Reclaim the genuinely-gone first. Closing a session whose client
      // vanished costs nobody anything; closing a live one costs its client a
      // re-handshake, so it is the second choice rather than the first.
      await sweep();

      // Walk the snapshot rather than re-finding the oldest each time. It
      // frees more than one slot when a cap lowered between restarts has left
      // the map above the new ceiling, and — because the list is finite — it
      // cannot spin, which a `while` on `sessions.size` could if an entry ever
      // failed to leave the map.
      for (const sessionId of byRecency()) {
        if (sessions.size < cap) break;
        await evict(sessionId, "capacity");
      }
    },
  };
}
