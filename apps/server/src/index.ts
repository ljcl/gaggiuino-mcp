import { ConfigError, loadServerConfig } from "./config";
import { createFetchHandler } from "./http";
import { logger } from "./logging";
import { describeSecurity, loadSecurityConfig } from "./mcpAuth";
import { SERVER_VERSION } from "./version";

/**
 * Bootstrap only: validate the environment, serve, wire the signals. Everything
 * with behaviour worth asserting lives in a module this imports, which is why
 * this file is the one exclusion from the coverage set.
 */

let config: ReturnType<typeof loadServerConfig>;
let security: ReturnType<typeof loadSecurityConfig>;
try {
  config = loadServerConfig();
  // Inside the same guard: `MCP_PUBLIC_URL` is validated here too, and a bad
  // one is worse than a bad PORT. It is the value an access token's audience is
  // checked against, so getting it wrong fails silently — discovery succeeds, a
  // token is issued, and then every request 401s.
  security = loadSecurityConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Fail before binding a port, and name the variable. A bad PORT used to bind
  // NaN and a bad GAGGIUINO_URL used to surface much later as a failed fetch
  // inside a tool call, blamed on the machine being offline.
  logger.error("config.invalid", { message: error.message });
  process.exit(1);
}

const handler = createFetchHandler({ security });

logger.info("server.starting", {
  machineUrl: config.machineUrl,
  version: SERVER_VERSION,
});
for (const report of describeSecurity(security)) {
  logger[report.level](report.event, report.fields);
}

const server = Bun.serve({
  fetch: handler.fetch,
  hostname: config.host,
  port: config.port,
});

const stopReaper = handler.startReaper();

logger.info("server.listening", {
  host: config.host,
  mcpEndpoint: `http://${config.host}:${config.port}/mcp`,
  port: config.port,
});

/**
 * `docker stop` sends SIGTERM, so handling only SIGINT meant the container was
 * killed after the grace period with every session still open. Stop accepting
 * first, then drain, so nothing lands on a transport that is being closed.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.stopping", { sessions: handler.sessions.size, signal });
  stopReaper();
  await server.stop();
  await handler.shutdown();
  logger.info("server.stopped", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
