import {
  type App,
  type McpUiDisplayMode,
} from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useState } from "react";
import { type ShellHostContext } from "./useHostRoot";

export interface DisplayModeControl {
  /** The mode the app is currently rendered in. */
  displayMode: McpUiDisplayMode;
  /** True when the host advertises fullscreen in `availableDisplayModes`. */
  canFullscreen: boolean;
  isFullscreen: boolean;
  /** Ask the host to swap between inline and fullscreen. No-op if unsupported. */
  toggleFullscreen: () => void;
}

/**
 * Drive the host's display mode.
 *
 * The host owns the container, so a request is exactly that: `requestDisplayMode`
 * answers with the mode it actually applied, which may differ from the one asked
 * for. That answer, and any later `host-context-changed` notification, are both
 * authoritative — whichever arrives last wins.
 */
export function useDisplayMode(
  app: App | null,
  hostContext: ShellHostContext,
): DisplayModeControl {
  const hostMode = hostContext.displayMode;
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>(
    hostMode ?? "inline",
  );

  useEffect(() => {
    if (hostMode) setDisplayMode(hostMode);
  }, [hostMode]);

  const canFullscreen =
    hostContext.availableDisplayModes?.includes("fullscreen") ?? false;
  const isFullscreen = displayMode === "fullscreen";

  const toggleFullscreen = useCallback(() => {
    if (!app || !canFullscreen) return;
    const next: McpUiDisplayMode = isFullscreen ? "inline" : "fullscreen";
    app
      .requestDisplayMode({ mode: next })
      .then((result) => setDisplayMode(result.mode))
      .catch(() => {
        // A rejected request means the host kept the current mode; there is
        // nothing for the user to do about it, so leave the UI as it is.
      });
  }, [app, canFullscreen, isFullscreen]);

  return { canFullscreen, displayMode, isFullscreen, toggleFullscreen };
}
