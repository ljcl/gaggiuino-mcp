import { TOOL_DEFINITIONS } from "../tools";

/**
 * Which tool calls need `espresso:write`, decided from the JSON-RPC body before
 * it reaches the MCP SDK.
 *
 * This check cannot live in a tool handler, and that is a protocol fact rather
 * than a style choice: once a handler is running, its return value is already
 * destined to be wrapped in a `200`. A `200` carrying `isError: true` produces
 * no authentication prompt at all — Claude passes the text to the model as a
 * tool result and moves on — so a refusal that is meant to trigger a step-up
 * has to be an HTTP status, which means it has to happen here.
 *
 * That makes this the documented exception to two rules in AGENTS.md: "expected
 * failures are results, not exceptions" and "`handleToolCall` is the only
 * dispatch point". Both still hold for everything that is not authentication.
 */

/**
 * The tools that need `espresso:write`, derived from the annotations rather
 * than listed.
 *
 * `readOnlyHint` is already the honest declaration of what a tool does, and it
 * is already asserted in both `server.test.ts` and `http.test.ts`. Deriving from
 * it means a new write tool inherits the scope gate instead of being forgotten;
 * a hand-written list is a second place to update and the one that gets missed.
 * A test pins the derived set to `{select_profile, upload_profile}` so that
 * inheritance stays visible rather than silent.
 */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set(
  TOOL_DEFINITIONS.filter(
    (tool) => tool.annotations.readOnlyHint === false,
  ).map((tool) => tool.name),
);

function toolNameOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { name } = params as { name?: unknown };
  return typeof name === "string" ? name : undefined;
}

/**
 * The protected tools this body invokes, in order.
 *
 * Arrays are handled as well as single messages: a JSON-RPC batch that slipped
 * one write in among reads must not pass because the first entry was harmless.
 */
export function protectedToolsIn(
  body: unknown,
  tools: ReadonlySet<string> = PROTECTED_TOOLS,
): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .map(toolNameOf)
    .filter((name): name is string => name !== undefined && tools.has(name));
}
