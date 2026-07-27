import { type App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef } from "react";

/** How long the view must hold still before its summary is worth sending. */
export const DEFAULT_CONTEXT_DEBOUNCE_MS = 400;

/**
 * Keep the model's picture of the view in sync with what is on screen.
 *
 * Without this the model only knows the arguments the tool was called with, so
 * a follow-up question about "the chart" is answered from stale information the
 * moment the user changes anything. Updates are debounced because view state
 * (toggling a series, loading a comparison) changes far faster than a
 * conversation turn, and deduplicated so an unchanged summary costs nothing.
 *
 * @param summary - Current description of the view, or `null` while there is
 *   nothing worth telling the model yet.
 */
export function useModelContextSync(
  app: App | null,
  summary: string | null,
  debounceMs = DEFAULT_CONTEXT_DEBOUNCE_MS,
): void {
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (!app || summary === null || summary === lastSent.current) return;

    const timer = setTimeout(() => {
      lastSent.current = summary;
      app
        .updateModelContext({ content: [{ text: summary, type: "text" }] })
        .catch(() => {
          // Context is an optimization, not a feature the user asked for.
          // A host that rejects it should not surface an error in the UI.
          lastSent.current = null;
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [app, summary, debounceMs]);
}
