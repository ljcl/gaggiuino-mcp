import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A tool result the server deliberately flagged with `isError`.
 *
 * The message is the server's own text, which for this server is written to be
 * actionable ("the machine may be powered off…"). Surfacing it verbatim is the
 * whole point of this class — it must never be replaced with a generic string.
 */
export class ServerToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerToolError";
  }
}

/** The tool succeeded but its payload was not the document the app expected. */
export class MalformedToolResultError extends Error {
  constructor(
    readonly toolName: string,
    detail: string,
  ) {
    super(`${toolName} returned a response this app could not read: ${detail}`);
    this.name = "MalformedToolResultError";
  }
}

/** First text block of a tool result, or `undefined` when there is none. */
export function firstTextBlock(result: CallToolResult): string | undefined {
  const text = result.content?.find((block) => block.type === "text")?.text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

/**
 * Read a tool result whose text block is a JSON document.
 *
 * @throws {ServerToolError} when the server flagged the result as an error
 * @throws {MalformedToolResultError} when the payload is missing or not JSON
 */
export function readToolJson<T>(result: CallToolResult, toolName: string): T {
  const text = firstTextBlock(result);

  if (result.isError) {
    throw new ServerToolError(
      text ?? `${toolName} failed, and the server gave no reason.`,
    );
  }

  if (text === undefined) {
    throw new MalformedToolResultError(toolName, "the response had no content");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MalformedToolResultError(toolName, "the response was not JSON");
  }
}

/**
 * Render any failure from a server tool call as text worth showing the user.
 *
 * `ServerToolError` passes straight through so the server keeps authorship of
 * its own diagnostics; everything else is a transport or programming failure
 * the user can only retry.
 */
export function describeToolError(error: unknown): string {
  if (error instanceof ServerToolError) return error.message;
  if (error instanceof MalformedToolResultError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
