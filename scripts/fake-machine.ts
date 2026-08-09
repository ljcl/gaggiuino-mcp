/**
 * Serve a fake Gaggiuino on localhost, so the MCP server can run with no
 * espresso machine on the network.
 *
 *   bun run fake-machine            # port 8080
 *   bun run fake-machine --port 9000
 *
 * Then, in another shell:
 *
 *   GAGGIUINO_URL=http://localhost:8080 bun run dev
 *
 * ## Why the logic is not in this file
 *
 * Everything worth checking — the payloads and the routing — lives in
 * `apps/server/src/__fixtures__/fakeMachine.ts`, which is type-checked, inside
 * the coverage set, and driven by `fakeMachine.test.ts` through the real client.
 * What is left here is a port and a listener.
 *
 * The split is also what keeps the fake out of the published image. This file is
 * at the repo root, and `apps/server/Dockerfile` copies only
 * `apps/server/src`, `apps/server/scripts` and `packages/shot-graph/dist` into
 * the runner — root `scripts/` is never part of the build context that
 * `turbo prune --docker` produces. Putting it in `apps/server/scripts/` would
 * have shipped it.
 *
 * ## What this is not
 *
 * It is not a substitute for hardware. It cannot reproduce a 503 while the
 * machine writes a shot to flash, the one-request-at-a-time serialisation of an
 * ESP32, the WebSocket-only profile update path, or the type inconsistencies of
 * a firmware revision nobody has captured. It answers reads from recorded
 * payloads and refuses writes. Its value is the process-level paths that
 * otherwise need a machine on the LAN: rendering `view_shot_graph` in a real
 * host, watching `/health` report an upstream that is actually up, and running
 * the server at all from somewhere that is not the owner's kitchen.
 */

import {
  FAKE_MACHINE_SUMMARY,
  routeFakeMachine,
} from "../apps/server/src/__fixtures__/fakeMachine";

const DEFAULT_PORT = 8080;

/** `--port N`, or the default. Deliberately argv rather than an environment
 *  variable: a `process.env` read here would need a `.env.example` entry it has
 *  no business having, and Biome's `noUndeclaredEnvVars` would flag it forever. */
function parsePort(argv: string[]): number {
  const flag = argv.indexOf("--port");
  if (flag === -1) return DEFAULT_PORT;
  const value = Number(argv[flag + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`Invalid --port: ${argv[flag + 1]}`);
    process.exit(1);
  }
  return value;
}

const port = parsePort(process.argv.slice(2));

const server = Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    const { body, status } = routeFakeMachine(request.method, pathname);
    console.error(`${status} ${request.method} ${pathname}`);
    return Response.json(body, { status });
  },
  port,
});

console.error(
  [
    `Fake Gaggiuino listening on ${server.url.origin}`,
    "",
    `  profiles:      ${FAKE_MACHINE_SUMMARY.profileCount} (selected: ${FAKE_MACHINE_SUMMARY.selectedProfileName})`,
    `  shots:         ${FAKE_MACHINE_SUMMARY.latestShotId}, ${FAKE_MACHINE_SUMMARY.previousShotId}`,
    "  writes:        refused with 501 — this fake is read-only",
    "",
    `Point the server at it:  GAGGIUINO_URL=${server.url.origin} bun run dev`,
  ].join("\n"),
);
