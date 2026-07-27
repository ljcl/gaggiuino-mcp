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
 * outruns the TTL. The cap sweeps before it rejects, so a burst of abandoned
 * sessions does not lock out a legitimate client that arrives later.
 */

/** The slice of the transport this module needs; keeps tests free of real transports. */
export interface ClosableSession {
  close(): Promise<void>;
}

export interface SessionManagerOptions {
  /** Reclaim a session after this long with no request. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** Hard ceiling on concurrent sessions. Default 64. */
  maxSessions?: number;
  /** Injectable clock. Tests drive expiry without waiting for it. */
  now?: () => number;
  /** Called with the id of every session the manager closes on its own. */
  onEvicted?: (sessionId: string, reason: "idle") => void;
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
   * Sweep, then report whether there is room for another session. Callers
   * reject with 503 when this is false.
   */
  tryReserve(): Promise<boolean>;
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

  const sessions = new Map<string, { lastSeen: number; session: T }>();

  async function sweep(): Promise<string[]> {
    const deadline = now() - idleTimeoutMs;
    const expired = [...sessions.entries()]
      .filter(([, entry]) => entry.lastSeen <= deadline)
      .map(([sessionId]) => sessionId);

    for (const sessionId of expired) {
      const entry = sessions.get(sessionId);
      // Delete before closing: `close()` fires the transport's `onclose`, which
      // calls back into `delete`. Removing the entry first keeps that reentrant
      // path a no-op instead of a second pass over a mutating map.
      sessions.delete(sessionId);
      onEvicted?.(sessionId, "idle");
      // One session refusing to close must not strand the rest of the sweep.
      await entry?.session.close().catch(() => {});
    }
    return expired;
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

    async tryReserve() {
      if (sessions.size < maxSessions) return true;
      await sweep();
      return sessions.size < maxSessions;
    },
  };
}
