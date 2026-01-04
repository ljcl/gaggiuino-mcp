export interface ClientConfig {
  baseUrl: string;
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

export interface MachineStatus {
  temperature: number;
  targetTemperature: number;
  pressure: number;
  weight: number;
  waterLevel: number;
  brewSwitchState: string;
  steamSwitchState: string;
  profileName: string;
  upTime: number;
}

export interface ShotData {
  id: string;
  duration: number;
  datapoints: {
    timeInShot: number[];
    pressure: number[];
    temperature: number[];
    shotWeight: number[];
    weightFlow: number[];
    waterPumped: number[];
    pumpFlow: number[];
    targetPressure: number[];
    targetPumpFlow: number[];
  };
  profile: {
    name: string;
    waterTemperature?: number;
    globalStopConditions?: {
      weight?: number;
      time?: number;
    };
    phases: Array<{
      type: string;
      stopConditions?: Record<string, number>;
    }>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapArray<T>(data: T | T[]): T {
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  return data as T;
}

export function createClient(config: ClientConfig) {
  const {
    baseUrl,
    maxRetries = 3,
    initialDelayMs = 1500,
    timeoutMs = 10000,
  } = config;

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`${normalizedBaseUrl}${path}`, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on HTTP errors (4xx, 5xx)
        if (lastError.message.startsWith("HTTP ")) {
          break;
        }

        // Retry on network/timeout errors
        if (attempt < maxRetries - 1) {
          await sleep(initialDelayMs * 2 ** attempt);
        }
      }
    }

    throw new Error(
      `Failed to connect after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  return {
    async getStatus(): Promise<MachineStatus> {
      const data = await request<MachineStatus[]>("/api/system/status");
      return unwrapArray(data);
    },

    async getLatestShotId(): Promise<string> {
      const data =
        await request<Array<{ lastShotId?: string }>>("/api/shots/latest");
      return unwrapArray(data).lastShotId ?? "";
    },

    async getShotData(shotId: string): Promise<ShotData> {
      const data = await request<ShotData[]>(`/api/shots/${shotId}`);
      return unwrapArray(data);
    },
  };
}
