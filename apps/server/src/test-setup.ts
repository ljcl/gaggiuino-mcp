import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setLogLevel } from "./logging";

// The suite drives well over a hundred tool calls and session lifecycles, each
// of which is a log record in production. Silencing them keeps a failure
// readable; `logging.test.ts` asserts the records with an injected sink.
setLogLevel("silent");

export const mockServer = setupServer();

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
