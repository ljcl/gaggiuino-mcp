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

Bun.serve({
  fetch: handler.fetch,
  hostname: HOST,
  port: PORT,
});

console.error(`Listening on http://${HOST}:${PORT}`);
console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.error("Shutting down...");
  for (const [id, transport] of handler.sessions) {
    console.error(`Closing session ${id}`);
    await transport.close();
  }
  process.exit(0);
});
