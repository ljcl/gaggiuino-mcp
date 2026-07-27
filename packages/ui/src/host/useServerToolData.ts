import { type App } from "@modelcontextprotocol/ext-apps";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeToolError } from "./toolResult";

/**
 * Where a server tool call is up to.
 *
 * `slow` is still a successful in-flight request — it exists so the UI can say
 * "still waiting on the machine" instead of spinning a skeleton forever.
 */
export type ServerToolStatus = "error" | "loading" | "ready" | "slow" | "idle";

/** How long a request may run before the UI admits it is taking a while. */
export const DEFAULT_SLOW_AFTER_MS = 4000;

export interface UseServerToolDataOptions<T> {
  app: App | null;
  toolName: string;
  /**
   * Arguments for the call, or `null` to suspend it — which is what an app
   * does before the host has delivered its tool input.
   */
  arguments: Record<string, unknown> | null;
  /** Turn the result into the app's data. Throwing here becomes an error state. */
  parse: (result: CallToolResult, toolName: string) => T;
  slowAfterMs?: number;
}

export interface ServerToolData<T> {
  data: T | null;
  status: ServerToolStatus;
  /** Text to show the user; the server's own wording when it supplied any. */
  error: string | null;
  /** Re-run the call. Safe to wire straight to a button. */
  retry: () => void;
}

/**
 * Call a server tool and track the whole lifecycle: loading, slow, ready,
 * error, retry.
 *
 * Failures are never swallowed. `app.callServerTool` throws on transport
 * faults and resolves with `isError` for tool-level faults; both land in
 * `error` as text, with the server's own message preferred over anything this
 * hook could invent.
 */
export function useServerToolData<T>({
  app,
  toolName,
  arguments: args,
  parse,
  slowAfterMs = DEFAULT_SLOW_AFTER_MS,
}: UseServerToolDataOptions<T>): ServerToolData<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    status: ServerToolStatus;
  }>({ data: null, error: null, status: "idle" });
  const [attempt, setAttempt] = useState(0);

  const parseRef = useRef(parse);
  parseRef.current = parse;

  // Arguments are JSON-RPC params, so serializing them is both a stable effect
  // key and a lossless way to carry them into the effect without a stale
  // closure over the caller's object identity.
  const argsKey = args === null ? null : JSON.stringify(args);

  // `attempt` is deliberately not read in the body: bumping it is how `retry`
  // re-runs a call whose app, tool, and arguments have not changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run trigger
  useEffect(() => {
    if (!app || argsKey === null) {
      setState({ data: null, error: null, status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ data: null, error: null, status: "loading" });

    const slowTimer = setTimeout(() => {
      if (cancelled) return;
      setState((prev) =>
        prev.status === "loading" ? { ...prev, status: "slow" } : prev,
      );
    }, slowAfterMs);

    app
      .callServerTool({
        arguments: JSON.parse(argsKey) as Record<string, unknown>,
        name: toolName,
      })
      .then((result) => {
        if (cancelled) return;
        setState({
          data: parseRef.current(result, toolName),
          error: null,
          status: "ready",
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          error: describeToolError(error),
          status: "error",
        });
      })
      .finally(() => clearTimeout(slowTimer));

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [app, toolName, argsKey, attempt, slowAfterMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, retry };
}

/**
 * One-shot version of the same call, for interactions that fetch on demand
 * rather than on mount. Shares `parse` with {@link useServerToolData} so both
 * paths fail the same way.
 */
export async function callServerToolData<T>(
  app: App,
  toolName: string,
  args: Record<string, unknown>,
  parse: (result: CallToolResult, toolName: string) => T,
): Promise<T> {
  return parse(
    await app.callServerTool({ arguments: args, name: toolName }),
    toolName,
  );
}
