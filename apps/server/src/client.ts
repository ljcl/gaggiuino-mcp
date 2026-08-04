/**
 * The Gaggiuino machine's HTTP client.
 *
 * ## Protocol reference
 *
 * The machine's REST surface is documented by the upstream project and vendored
 * verbatim at `docs/upstream/rest-api.md` (retrieved 2026-08-04); the WebSocket
 * protocol is at `docs/upstream/websocket.md`. Line references below are into
 * those files.
 *
 * **The reference settles existence questions, not shape questions.** It is
 * hand-written and disagrees with itself about types — `lcdDarkMode` is the
 * string `"false"` at L283 and the boolean `false` at L118; `forcePredictive`
 * and `hwScalesEnabled` are strings at L330-331 and booleans at L117 — and four
 * of the six endpoints this client calls have no response example at all. So
 * the loose schemas below are **policy, not drift**, and nothing in the
 * reference is evidence for narrowing one.
 *
 * ### What this client calls
 *
 * | Endpoint | Ref | Caching |
 * | --- | --- | --- |
 * | `GET /api/shots/latest` | §1 L15-17 | `LATEST_SHOT_TTL_MS` |
 * | `GET /api/shots/*` | §1 L19-22 | `SHOT_TTL_MS` |
 * | `GET /api/profiles/all` | §2 L32-34 | `MACHINE_CONFIG_TTL_MS`, `unwrap: false` |
 * | `GET /api/profile/*` | §2 L46-74 | `MACHINE_CONFIG_TTL_MS` |
 * | `GET /api/settings` | §4 L106-122 | `MACHINE_CONFIG_TTL_MS` |
 * | `GET /api/system/status` | §3 L100-102 | deliberately uncached |
 * | `GET /api/maintenance` | §5 L467-484 | `MACHINE_CONFIG_TTL_MS` |
 * | `POST /api/profile-select/*` | §2 L36-39 | none; id in the path, no body |
 * | `POST /api/profile` | §2 L77-96 | none; body, and **never retried** |
 *
 * The reference spells ids as a wildcard `*` rather than `{id}`.
 *
 * ### What this client deliberately does not call
 *
 * Recorded so "why doesn't the server expose X" starts from a decision.
 *
 * - `POST /api/shots` (L10-13) — the machine writes its own shot records;
 *   nothing here has shot data to upload.
 * - `DELETE /api/shots/*` (L24-28) — destructive, needs an SD card, and no
 *   read-only story asks for it.
 * - `DELETE /api/profile-select/*` (L41-44) — despite sharing a path with the
 *   profile *selector*, this **deletes a profile**. The two differ only by HTTP
 *   method, which is exactly why it is written down here: a model one token
 *   away from `select` must never be able to reach it.
 * - Every `POST /api/settings/*` (L144, L203, L252, L296, L343, L396) —
 *   writing boiler setpoints from a chat window is a far heavier permission
 *   story than `select_profile`, and nobody has asked for it.
 * - `POST /api/firmware/update-all` and `GET /api/firmware/progress` (§6) —
 *   flashing an espresso machine from a conversation.
 * - `GET /api/health` (L518-526) — a real upstream liveness endpoint, and still
 *   not called. `recordUpstream` already observes liveness from the requests
 *   this server makes anyway, and a probe would put steady load on the one
 *   ESP32 the caching here exists to spare. (Note also L528: the firmware/OTA
 *   endpoints, `/api/health` among them, do *not* send
 *   `Access-Control-Allow-Origin`, contradicting Notes item 1 at L532 —
 *   irrelevant server-side, but it means the shot-graph app could never call it
 *   from the browser.)
 * - `GET /api/settings/versions` (L427-444) — its three fields are already
 *   inside the `/api/settings` aggregate this client fetches, so calling it
 *   would be a second round trip for data already in hand.
 */

import { z } from "zod";
import { createCache } from "./cache";
import { DEFAULT_MACHINE_URL } from "./config";
import {
  MalformedUpstreamError,
  UpstreamHttpError,
  UpstreamUnreachableError,
} from "./errors";

export interface ClientConfig {
  baseUrl: string;
  /** Live cache entries; one shot payload is hundreds of datapoints. */
  cacheMaxEntries?: number;
  initialDelayMs?: number;
  maxRetries?: number;
  /** Injected for tests, and shared by the cache and the overall deadline. */
  now?: () => number;
  /** Ceiling on one logical request, retries and backoff included. */
  overallTimeoutMs?: number;
  /** Ceiling on a single attempt. */
  timeoutMs?: number;
}

/**
 * How long each resource may be served from cache.
 *
 * A completed shot is immutable — the machine writes the record once the shot
 * ends and never revises it — so the only reason to bound it at all is memory
 * and the small chance the id is reused across a firmware reflash.
 *
 * `/api/shots/latest` gets seconds rather than minutes. It exists to fold the
 * burst a single question produces (get the latest id, then summarize it, then
 * render it) without pinning a stale id across the ninety seconds it takes to
 * pull another shot and ask again.
 *
 * `/api/system/status` is deliberately absent. Every value it reports is
 * instantaneous and the tool's own description promises the caller a fresh
 * reading; a cache there would answer "is it up to temperature yet" with the
 * answer from before.
 */
export const SHOT_TTL_MS = 10 * 60_000;
export const LATEST_SHOT_TTL_MS = 5_000;

/**
 * Profiles and settings are edited on the machine itself, so they are cached
 * only long enough to fold the burst one question makes of them — list the
 * profiles, then describe one — not long enough to keep serving a profile the
 * user just deleted.
 */
export const MACHINE_CONFIG_TTL_MS = 30_000;

/**
 * Statuses worth trying again.
 *
 * Every HTTP status used to short-circuit the retry loop on the reasoning that
 * the machine had given a definitive answer. That is true of a 404 and a 400;
 * it is not true of a 503 from a webserver on a microcontroller that was busy
 * writing a shot to flash, which is the single most common transient failure
 * this upstream produces.
 */
function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Schemas for what the machine sends back. They are deliberately loose: only
 * the fields this server would crash without are required, unknown keys are
 * preserved, and everything else is optional so a firmware revision that adds
 * or drops a field does not take the server down. What they do buy us is that
 * a truncated body, an error page, or an empty array fails here — with the
 * offending path named — instead of surfacing as `Cannot read properties of
 * undefined` several modules later.
 */
const IdSchema = z.union([z.string(), z.number()]).transform(String);

/** The machine reports switch positions as the strings "true"/"false". */
const SwitchStateSchema = z.union([z.string(), z.boolean()]);

/**
 * `/api/system/status` reports every numeric field as a decimal *string*
 * ("temperature":"77.627335"), unlike the shot endpoints which send real
 * numbers. Accept either and normalize to a number, the same way IdSchema
 * and SwitchStateSchema already absorb this firmware's stringly-typed JSON.
 *
 * This is captured behaviour, not spec: the reference gives that endpoint one
 * sentence and no example (rest-api.md L100-102), so it neither confirms nor
 * contradicts it. The evidence is `mockMachineStatusFromHardware`, taken
 * verbatim off a real machine on 2026-07-27.
 *
 * What the reference *does* corroborate is the habit. It prints the same field
 * with two types in two places — `forcePredictive`/`hwScalesEnabled` as
 * `"false"`/`"true"` under `GET /api/settings/scales` (L330-331) and as real
 * booleans in the aggregate (L117); `lcdDarkMode` as `"false"` at L283 and
 * `false` at L118 — and `brewDeltaState`, `dreamSteamState` (L138-139) and the
 * LED `state`/`disco` (L383-384) are strings throughout. A document that
 * disagrees with itself about a field's type inside one file is the strongest
 * argument available for keeping these unions.
 */
const NumericSchema = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .refine(Number.isFinite, { message: "expected a number or numeric string" });

export const MachineStatusSchema = z.looseObject({
  brewSwitchState: SwitchStateSchema.optional(),
  pressure: NumericSchema,
  profileName: z.string().optional(),
  steamSwitchState: SwitchStateSchema.optional(),
  targetTemperature: NumericSchema.optional(),
  temperature: NumericSchema,
  upTime: NumericSchema.optional(),
  waterLevel: NumericSchema.optional(),
  weight: NumericSchema.optional(),
});

export type MachineStatus = z.output<typeof MachineStatusSchema>;

const LatestShotSchema = z.looseObject({
  lastShotId: IdSchema.optional(),
});

const MachineProfileSchema = z.looseObject({
  /**
   * The value `/api/profile-select/{id}` wants. Optional because a firmware
   * that only lists names is still a useful answer to "what is on the machine"
   * — it just cannot be selected from here.
   */
  id: IdSchema.optional(),
  name: z.string(),
});

export type MachineProfile = z.output<typeof MachineProfileSchema>;

/**
 * Firmware disagrees with itself about whether a collection is the response or
 * lives under a key, so both are accepted and normalized to the array. This is
 * the same tolerance `unwrapArray` applies to single objects, in the other
 * direction.
 *
 * The reference does not settle it and cannot be used to narrow this union: it
 * documents `GET /api/profiles/all` in one line with no response example
 * (rest-api.md L32-34). What makes the tolerance safe to keep is the test at
 * `client.test.ts`'s "rejects an empty array as a malformed response" — that is
 * the only thing standing between a truncated body and a silently empty profile
 * list.
 */
const MachineProfilesSchema = z.union([
  z.array(MachineProfileSchema),
  z
    .looseObject({ profiles: z.array(MachineProfileSchema) })
    .transform((body) => body.profiles),
]);

/**
 * Settings are passed through untouched: which knobs exist is a firmware
 * decision, and pinning them here would drop fields a newer build added rather
 * than showing them to the user.
 *
 * That has a consequence the audit against the reference turned up. This
 * aggregate includes the `system` section (rest-api.md L109, L115), and that
 * section is documented as carrying `sprofilerToken`, `visualizerToken`,
 * `mqttUsername`, and `mqttPassword` (L182-183, L193-194). The schema still
 * stays loose — modelling the payload here would drop the new knob a user is
 * asking about, which is the whole point — so the credential filter lives at the
 * *presentation* boundary instead, in `tools.ts`'s `renderSettingValue`.
 *
 * **Any future consumer of `getSettings()` must route through that rather than
 * printing the object.**
 */
const MachineSettingsSchema = z.looseObject({});

export type MachineSettings = z.output<typeof MachineSettingsSchema>;

/**
 * The machine's service log (rest-api.md §5, L467-484).
 *
 * Nothing is required, for the same reason the settings schema requires
 * nothing: which services a build tracks is a firmware decision, and pinning
 * `lastDescaleTimestamp` here would turn a firmware that only logged
 * backflushes into a `MalformedUpstreamError`. What the object still buys is
 * the usual boundary guarantee — an error page, a truncated body, or a bare
 * array fails here with `/api/maintenance` named rather than several modules
 * later. `maintenance.ts` is where the keys are interpreted.
 */
const MachineMaintenanceSchema = z.looseObject({});

export type MachineMaintenance = z.output<typeof MachineMaintenanceSchema>;

const NumberSeries = z.array(z.number());

const ShotDatapointsSchema = z.looseObject({
  pressure: NumberSeries.optional(),
  pumpFlow: NumberSeries.optional(),
  shotWeight: NumberSeries.optional(),
  targetPressure: NumberSeries.optional(),
  targetPumpFlow: NumberSeries.optional(),
  temperature: NumberSeries.optional(),
  timeInShot: NumberSeries.optional(),
  waterPumped: NumberSeries.optional(),
  weightFlow: NumberSeries.optional(),
});

const ShotProfileSchema = z.looseObject({
  globalStopConditions: z
    .looseObject({
      time: z.number().optional(),
      weight: z.number().optional(),
    })
    .optional(),
  name: z.string().optional(),
  phases: z
    .array(
      z.looseObject({
        stopConditions: z.record(z.string(), z.number()).optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
  waterTemperature: z.number().optional(),
});

export const ShotDataSchema = z.looseObject({
  datapoints: ShotDatapointsSchema,
  duration: z.number(),
  id: IdSchema,
  profile: ShotProfileSchema,
});

export type ShotData = z.output<typeof ShotDataSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the machine has answered us lately.
 *
 * Recorded from the requests the server already makes rather than from a
 * synthetic probe: the upstream is an ESP32 on Wi-Fi, and a `/health` endpoint
 * that pinged it on a timer would put steady load on the one device we are
 * trying not to hammer. The cost is that a server nobody has used yet reports
 * `unknown`, which is the truth.
 *
 * "Reachable" means the machine answered, not that it answered well: a 404 for
 * a shot that does not exist still proves the network path works, so only a
 * genuine network failure sets `unreachable`.
 */
export type UpstreamState = "ok" | "unknown" | "unreachable";

export interface UpstreamHealth {
  lastCheckedAt?: string;
  lastError?: string;
  state: UpstreamState;
}

let upstreamHealth: UpstreamHealth = { state: "unknown" };

function recordUpstream(state: UpstreamState, error?: string): void {
  upstreamHealth = {
    lastCheckedAt: new Date().toISOString(),
    ...(error === undefined ? {} : { lastError: error }),
    state,
  };
}

export function getUpstreamHealth(): UpstreamHealth {
  return { ...upstreamHealth };
}

/**
 * A genuine disagreement the audit found, and a reason to keep tolerating both
 * shapes: every response example in the reference is a **bare object** (e.g.
 * rest-api.md L112-122 for `/api/settings`, L178-197 for
 * `/api/settings/system`), while this repo's msw handlers wrap single records in
 * a one-element array because that is what the machine was observed doing.
 * The reference is a hand-written document, not a packet capture, so it is not
 * evidence to drop either shape.
 */
function unwrapArray(data: unknown): unknown {
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  return data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function createClient(config: ClientConfig) {
  const {
    baseUrl,
    cacheMaxEntries = 32,
    initialDelayMs = 1500,
    maxRetries = 3,
    now = Date.now,
    overallTimeoutMs = 20000,
    timeoutMs = 10000,
  } = config;

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const cache = createCache<unknown>({ maxEntries: cacheMaxEntries, now });

  interface RequestOptions {
    method?: "GET" | "POST";
    /** Serve this path from cache for this long. Omit to always fetch. */
    ttlMs?: number;
  }

  /**
   * How a successful response becomes a value.
   *
   * Split out because not every endpoint answers with JSON. `profile-select`
   * replies with a short ack whose format is a firmware detail, and calling
   * `.json()` on it would turn a successful selection into a parse failure and
   * then — since a syntax error is not one of the definitive failures — retry
   * a request that had already worked.
   */
  type BodyReader<T> = (response: Response, path: string) => Promise<T>;

  function jsonReader<T>(
    schema: z.ZodType<T>,
    /**
     * Whether a one-element array should be treated as the object inside it.
     * True for every endpoint that returns a single record, and false for the
     * ones whose array *is* the answer.
     */
    unwrap: boolean,
  ): BodyReader<T> {
    return async (response, path) => {
      const body = await response.json();
      const parsed = schema.safeParse(unwrap ? unwrapArray(body) : body);
      if (!parsed.success) {
        throw new MalformedUpstreamError(path, describeIssues(parsed.error));
      }
      return parsed.data;
    };
  }

  /** For endpoints whose whole answer is the status code. */
  const statusReader: BodyReader<void> = async (response) => {
    // Drained rather than ignored so the connection is released; the ESP32
    // serves one request at a time and a dangling body costs the next caller.
    await response.text();
  };

  async function perform<T>(
    path: string,
    read: BodyReader<T>,
    { method = "GET", ttlMs }: RequestOptions = {},
  ): Promise<T> {
    if (ttlMs !== undefined) {
      const hit = cache.get(path);
      // Deliberately no `recordUpstream("ok")` here. A cache hit says the
      // machine answered *once*, not that it is answering now, and /health
      // exists to answer exactly that question — reporting a machine as up
      // because we still remember its last shot would make the endpoint lie
      // for as long as the TTL.
      if (hit !== undefined) return hit as T;
    }

    // The deadline is what a host actually feels. Three attempts at a 10s
    // timeout plus 1.5s and 3s of backoff is ~34s, past the point where most
    // hosts abandon a tool call — so the model saw a timeout with no message
    // rather than "the machine may be powered off".
    const deadlineAt = now() + overallTimeoutMs;
    let lastError: Error | undefined;
    let lastHttpError: UpstreamHttpError | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) break;

      attempts += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(timeoutMs, remaining),
      );

      try {
        const response = await fetch(`${normalizedBaseUrl}${path}`, {
          method,
          signal: controller.signal,
        });

        // An HTTP status — any HTTP status — proves the network path works.
        recordUpstream("ok");

        if (!response.ok) {
          throw new UpstreamHttpError(
            response.status,
            response.statusText,
            path,
          );
        }

        const value = await read(response, path);
        if (ttlMs !== undefined) cache.set(path, value, ttlMs);
        return value;
      } catch (error) {
        // A body we cannot parse is a definitive answer: the machine is
        // running firmware this server does not understand, and asking it
        // again produces the same bytes.
        if (error instanceof MalformedUpstreamError) throw error;

        if (error instanceof UpstreamHttpError) {
          if (!isRetriableStatus(error.status)) throw error;
          lastHttpError = error;
        } else {
          lastError = error as Error;
        }

        if (attempt >= maxRetries - 1) break;
        // A retry with its backoff skipped is just hammering a machine that
        // has already failed, so no budget for the wait means no budget for
        // the attempt either.
        const backoff = initialDelayMs * 2 ** attempt;
        if (deadlineAt - now() <= backoff) break;
        await sleep(backoff);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // A machine that answered 503 three times is reachable and faulty, which is
    // a different thing to tell the user than "it may be powered off".
    if (lastHttpError) throw lastHttpError;

    const reason =
      lastError?.message ?? `no attempt completed within ${overallTimeoutMs}ms`;
    recordUpstream("unreachable", reason);
    throw new UpstreamUnreachableError(Math.max(attempts, 1), reason);
  }

  function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { unwrap?: boolean } = {},
  ): Promise<T> {
    const { unwrap = true, ...rest } = options;
    return perform(path, jsonReader(schema, unwrap), rest);
  }

  return {
    async getLatestShotId(): Promise<string> {
      const data = await request("/api/shots/latest", LatestShotSchema, {
        ttlMs: LATEST_SHOT_TTL_MS,
      });
      return data.lastShotId ?? "";
    },

    async getShotData(shotId: string): Promise<ShotData> {
      return request(`/api/shots/${shotId}`, ShotDataSchema, {
        ttlMs: SHOT_TTL_MS,
      });
    },

    async getMachineProfiles(): Promise<MachineProfile[]> {
      return request("/api/profiles/all", MachineProfilesSchema, {
        ttlMs: MACHINE_CONFIG_TTL_MS,
        unwrap: false,
      });
    },

    /**
     * The counters only move when a shot is recorded, minutes apart, so the
     * 30-second "fold one question's burst" window is the right cache — long
     * enough to answer a follow-up for free, short enough not to keep serving a
     * stale count after a descale recorded mid-conversation.
     */
    async getMaintenance(): Promise<MachineMaintenance> {
      return request("/api/maintenance", MachineMaintenanceSchema, {
        ttlMs: MACHINE_CONFIG_TTL_MS,
      });
    },

    async getSettings(): Promise<MachineSettings> {
      return request("/api/settings", MachineSettingsSchema, {
        ttlMs: MACHINE_CONFIG_TTL_MS,
      });
    },

    async getStatus(): Promise<MachineStatus> {
      return request("/api/system/status", MachineStatusSchema);
    },

    /**
     * The one call in this client that changes the machine.
     *
     * Retrying it is safe for the same reason the tool advertises
     * `idempotentHint: true`: selecting profile 15 twice leaves the machine in
     * the state selecting it once does. That is a property of this endpoint,
     * not of POST in general — a future write that is not idempotent must not
     * inherit this loop without saying so. (`createProfile` below is that
     * write, and it says so.)
     *
     * The reference confirms the shape — `POST /api/profile-select/*`, id in the
     * path, no body (rest-api.md L36-39) — which is why this call needs nothing
     * from `perform()` that a GET does not. It also confirms that the sibling
     * `DELETE /api/profile-select/*` (L41-44) **deletes a profile**. That is
     * recorded here rather than in a commit message because the two differ only
     * by HTTP method.
     */
    async selectProfile(machineProfileId: string): Promise<void> {
      await perform(
        `/api/profile-select/${encodeURIComponent(machineProfileId)}`,
        statusReader,
        { method: "POST" },
      );
    },
  };
}

export const MACHINE_URL =
  process.env.GAGGIUINO_URL?.trim() || DEFAULT_MACHINE_URL;

let cachedClient: ReturnType<typeof createClient> | null = null;
let clientOverrides: Partial<ClientConfig> = {};

/** The process-wide client for the configured machine. */
export function getClient() {
  if (!cachedClient) {
    cachedClient = createClient({ baseUrl: MACHINE_URL, ...clientOverrides });
  }
  return cachedClient;
}

/**
 * Drop the cached client so tests can re-intercept its requests. The optional
 * config applies to the client built on the next `getClient()` call, which is
 * how tests exercise the retry path without waiting out the real backoff.
 */
export function resetClient(config: Partial<ClientConfig> = {}) {
  cachedClient = null;
  clientOverrides = config;
  // Observed upstream health is process-wide too, so it resets with the client
  // — otherwise one test's failed fetch would leak into the next one's
  // assertion about a freshly started server.
  upstreamHealth = { state: "unknown" };
}
