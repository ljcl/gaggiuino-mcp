/**
 * Startup configuration, validated before the port is bound.
 *
 * `PORT` used to go through a bare `Number(...)` with no NaN guard, so
 * `PORT=eight-thousand` bound port NaN and produced a confusing runtime error
 * rather than a message naming the variable. `GAGGIUINO_URL` was never parsed
 * at all — a typo surfaced later as a failed fetch inside a tool call, blamed
 * on the machine being offline.
 *
 * Everything here fails fast and says which variable is wrong.
 */

export const DEFAULT_MACHINE_URL = "http://gaggiuino.local";
export const DEFAULT_PORT = 8000;
export const DEFAULT_HOST = "0.0.0.0";

export interface ServerConfig {
  host: string;
  machineUrl: string;
  port: number;
}

/** Thrown for a bad environment; `index.ts` prints the message and exits 1. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

function parseMachineUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return DEFAULT_MACHINE_URL;
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `GAGGIUINO_URL must be a valid URL, got ${JSON.stringify(raw)} (did you omit the http:// prefix?)`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `GAGGIUINO_URL must be http or https, got ${JSON.stringify(url.protocol)}`,
    );
  }
  // The client appends paths to this, so a trailing slash would double up.
  return raw.replace(/\/$/, "");
}

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    machineUrl: parseMachineUrl(env.GAGGIUINO_URL),
    port: parsePort(env.PORT),
  };
}
