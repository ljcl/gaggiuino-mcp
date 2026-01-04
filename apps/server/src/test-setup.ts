import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export const mockServer = setupServer();

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
