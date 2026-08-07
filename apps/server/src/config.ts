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

/**
 * Refuse to start while the removed shared secret is still set.
 *
 * `MCP_AUTH_TOKEN` was deleted in 2.0.0 because a Claude connector has no way
 * to present it. Deleting the code that read it would have been silent in the
 * one direction that matters: an unread variable is an ignored variable, so a
 * deployment that set the token deliberately — and the README told exactly
 * those users to, before putting the server behind a tunnel — would go from a
 * 401-gated `/mcp` to an open one with nothing in the logs to say so.
 *
 * The major version is not the protection. `docker.yml` publishes `latest` on
 * every push to the default branch, and `docker-compose.yml` defaults to
 * `${GAGGIUINO_MCP_TAG:-latest}`, so the documented deployment follows `main`
 * and receives this change before a 2.0.0 tag exists to warn anyone. Failing
 * to start is what protects them, and it is a startup failure rather than a
 * warning precisely because a warning scrolls past in a container log.
 *
 * This is a tombstone with an expiry: #114 removes it one release later, by
 * which point a still-set variable is somebody's stale `.env` rather than a
 * live control that just stopped working.
 */
function assertLegacyTokenUnset(value: string | undefined): void {
  if (!value?.trim()) return;
  throw new ConfigError(
    "MCP_AUTH_TOKEN is set, but it was removed in 2.0.0 and no longer authenticates anything — a Claude connector could never present it, since the custom-connector dialog has no request-header field. Rather than serve /mcp unauthenticated while your .env still says otherwise, this server refuses to start. Configure OAuth instead (MCP_PUBLIC_URL, MCP_OAUTH_SECRET and MCP_OAUTH_PASSPHRASE_HASH — see README > Securing the endpoint), then delete the MCP_AUTH_TOKEN line.",
  );
}

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // Before anything is parsed: the answer is "stop", so there is nothing to be
  // gained by first reporting that PORT is also wrong.
  assertLegacyTokenUnset(env.MCP_AUTH_TOKEN);
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    machineUrl: parseMachineUrl(env.GAGGIUINO_URL),
    port: parsePort(env.PORT),
  };
}
