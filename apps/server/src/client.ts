import { z } from "zod";
import {
  MalformedUpstreamError,
  UpstreamHttpError,
  UpstreamUnreachableError,
} from "./errors";

export interface ClientConfig {
  baseUrl: string;
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
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

export const MachineStatusSchema = z.looseObject({
  brewSwitchState: SwitchStateSchema.optional(),
  pressure: z.number(),
  profileName: z.string().optional(),
  steamSwitchState: SwitchStateSchema.optional(),
  targetTemperature: z.number().optional(),
  temperature: z.number(),
  upTime: z.number().optional(),
  waterLevel: z.number().optional(),
  weight: z.number().optional(),
});

export type MachineStatus = z.output<typeof MachineStatusSchema>;

const LatestShotSchema = z.looseObject({
  lastShotId: IdSchema.optional(),
});

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
    maxRetries = 3,
    initialDelayMs = 1500,
    timeoutMs = 10000,
  } = config;

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${normalizedBaseUrl}${path}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new UpstreamHttpError(
            response.status,
            response.statusText,
            path,
          );
        }

        const body = await response.json();
        const parsed = schema.safeParse(unwrapArray(body));
        if (!parsed.success) {
          throw new MalformedUpstreamError(path, describeIssues(parsed.error));
        }
        return parsed.data;
      } catch (error) {
        // An HTTP status or a body we cannot parse is a definitive answer from
        // the machine; retrying cannot change it.
        if (
          error instanceof UpstreamHttpError ||
          error instanceof MalformedUpstreamError
        ) {
          throw error;
        }

        lastError = error as Error;

        // Retry on network/timeout errors
        if (attempt < maxRetries - 1) {
          await sleep(initialDelayMs * 2 ** attempt);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new UpstreamUnreachableError(
      maxRetries,
      lastError?.message ?? "unknown error",
    );
  }

  return {
    async getStatus(): Promise<MachineStatus> {
      return request("/api/system/status", MachineStatusSchema);
    },

    async getLatestShotId(): Promise<string> {
      const data = await request("/api/shots/latest", LatestShotSchema);
      return data.lastShotId ?? "";
    },

    async getShotData(shotId: string): Promise<ShotData> {
      return request(`/api/shots/${shotId}`, ShotDataSchema);
    },
  };
}

export const MACHINE_URL =
  process.env.GAGGIUINO_URL ?? "http://gaggiuino.local";

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
}
