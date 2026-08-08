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

/**
 * Validate `MCP_PUBLIC_URL` — the external identity this server answers as.
 *
 * The server has never needed to know its own public URL, and it cannot infer
 * one: Tailscale Funnel terminates TLS and hands the container plain HTTP on a
 * private address. It must not come from the `Host` header either, because the
 * value ends up as the `resource` an access token's audience is checked
 * against, and a caller controls `Host`.
 *
 * Returns the RFC 8707 canonical origin, which is what a client sends as
 * `resource`. `URL` does most of the canonicalisation itself — lowercasing the
 * scheme and host, dropping a default `:443`, dropping a trailing slash — so
 * those are normalised rather than rejected. What is rejected is anything that
 * would make the value ambiguous: a path (the issuer must stay a bare origin so
 * RFC 8414's path-insertion collapses), a query, a fragment, credentials, or a
 * scheme that is not https.
 *
 * Getting this wrong is silent in the worst way: discovery succeeds, a token is
 * issued, and then every single request 401s. `index.ts` logs the canonical
 * value at startup for exactly that reason.
 */
export function parsePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `MCP_PUBLIC_URL must be a valid URL, got ${JSON.stringify(raw)} (did you omit the https:// prefix?)`,
    );
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(
      `MCP_PUBLIC_URL must be https, got ${JSON.stringify(url.protocol)}. Claude reaches this server over the public internet, and OAuth credentials cannot cross plain HTTP.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(
      "MCP_PUBLIC_URL must not contain credentials; it is published in discovery metadata",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      `MCP_PUBLIC_URL must be a bare origin with no path, query or fragment, got ${JSON.stringify(raw)} (try ${JSON.stringify(url.origin)})`,
    );
  }
  return url.origin;
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
