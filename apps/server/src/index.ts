import { createFetchHandler } from "./http";
import { describeSecurity, loadSecurityConfig } from "./mcpAuth";
import { SERVER_VERSION } from "./version";

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";

const security = loadSecurityConfig();
const handler = createFetchHandler({ security });

console.error(`Starting Gaggiuino MCP server v${SERVER_VERSION}...`);
console.error(
  `Connecting to: ${process.env.GAGGIUINO_URL ?? "http://gaggiuino.local"}`,
);
for (const line of describeSecurity(security)) console.error(line);

const server = Bun.serve({
  fetch: handler.fetch,
  hostname: HOST,
  port: PORT,
});

const stopReaper = handler.startReaper();

console.error(`Listening on http://${HOST}:${PORT}`);
console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);

/**
 * `docker stop` sends SIGTERM, so handling only SIGINT meant the container was
 * killed after the grace period with every session still open. Stop accepting
 * first, then drain, so nothing lands on a transport that is being closed.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`${signal} received, shutting down...`);
  stopReaper();
  await server.stop();
  await handler.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
