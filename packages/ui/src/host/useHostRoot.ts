import {
  type App,
  type McpUiAppCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { type Implementation } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  detectMobile,
  type LayoutMode,
  MOBILE_BREAKPOINT_PX,
} from "./layoutMode";

/**
 * The slice of host context an app shell reads. Narrower than
 * `McpUiHostContext` on purpose: everything here drives layout, chrome, or a
 * host capability, and nothing else is copied into React state.
 */
export type ShellHostContext = Pick<
  McpUiHostContext,
  | "platform"
  | "containerDimensions"
  | "safeAreaInsets"
  | "deviceCapabilities"
  | "userAgent"
  | "displayMode"
  | "availableDisplayModes"
>;

const HOST_CONTEXT_KEYS = [
  "platform",
  "containerDimensions",
  "safeAreaInsets",
  "deviceCapabilities",
  "userAgent",
  "displayMode",
  "availableDisplayModes",
] as const satisfies readonly (keyof ShellHostContext)[];

/**
 * Copy the keys the shell cares about, skipping absent ones.
 *
 * The skip is load-bearing: `host-context-changed` carries only the fields
 * that changed, so merging a notification that spells out every key as
 * `undefined` would erase context the host still considers current.
 */
function pickShellContext(ctx: McpUiHostContext): ShellHostContext {
  const next: Record<string, unknown> = {};
  for (const key of HOST_CONTEXT_KEYS) {
    if (ctx[key] !== undefined) next[key] = ctx[key];
  }
  return next as ShellHostContext;
}

export interface UseHostRootOptions<TInput> {
  /** App identification sent to the host during the handshake. */
  appInfo: Implementation;
  /**
   * Narrow the host's raw tool arguments into this app's input type. Return
   * `null` for arguments the app cannot render, which keeps the shell in its
   * "waiting for input" state instead of mounting with a broken payload.
   */
  parseToolInput: (args: Record<string, unknown> | undefined) => TInput | null;
  /** Features this app provides to the host. Defaults to none. */
  capabilities?: McpUiAppCapabilities;
}

export interface HostRoot<TInput> {
  /** Connected app instance, or `null` while the handshake is in flight. */
  app: App | null;
  /** Set when the handshake failed; the app cannot recover from this. */
  connectError: Error | null;
  /** Tool arguments once the host has sent them, `null` until then. */
  toolInput: TInput | null;
  /** Host context, seeded at connect and kept current by host notifications. */
  hostContext: ShellHostContext;
  /** Layout to render, derived from every signal the host offers. */
  mode: LayoutMode;
}

/**
 * Subscribe to `window.innerWidth` so the app re-renders when the iframe is
 * resized. This is the most reliable mobile signal when the host does not
 * populate `platform` or `containerDimensions` (e.g. current Claude iOS
 * builds). The server snapshot returns a desktop width because there is no
 * window to measure during SSR or a static story build.
 */
function useViewportWidth(): number {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("resize", notify);
      return () => window.removeEventListener("resize", notify);
    },
    () => window.innerWidth,
    () => MOBILE_BREAKPOINT_PX + 1,
  );
}

/**
 * Connect to the MCP host and track everything an app shell needs from it:
 * tool input, host context, host styles, and the layout mode.
 *
 * Handlers are registered in `onAppCreated` — before `connect()` — because the
 * host fires `tool-input` and `host-context-changed` once, immediately after
 * the handshake. Registering later races those notifications away.
 */
export function useHostRoot<TInput>({
  appInfo,
  parseToolInput,
  capabilities = {},
}: UseHostRootOptions<TInput>): HostRoot<TInput> {
  const [toolInput, setToolInput] = useState<TInput | null>(null);
  const [hostContext, setHostContext] = useState<ShellHostContext>({});

  // `useApp` only reads its options once, so the handler it registers must read
  // the caller's latest parser through a ref rather than close over the first.
  const parseRef = useRef(parseToolInput);
  parseRef.current = parseToolInput;

  const { app, error: connectError } = useApp({
    appInfo,
    capabilities,
    onAppCreated: (created) => {
      created.addEventListener("toolinput", (input) => {
        const parsed = parseRef.current(input.arguments);
        if (parsed !== null) setToolInput(parsed);
      });
      created.addEventListener("hostcontextchanged", (ctx) => {
        setHostContext((prev) => ({ ...prev, ...pickShellContext(ctx) }));
      });
      created.onerror = console.error;
    },
  });

  // The initialize result carries a first host context that never arrives as a
  // change notification, so seed from it once the app connects.
  useEffect(() => {
    const initial = app?.getHostContext();
    if (initial) {
      setHostContext((prev) => ({ ...pickShellContext(initial), ...prev }));
    }
  }, [app]);

  const viewportWidth = useViewportWidth();

  useHostStyles(app, app?.getHostContext());

  const mode: LayoutMode = detectMobile(
    hostContext,
    viewportWidth,
    typeof navigator === "undefined" ? "" : navigator.userAgent,
  )
    ? "mobile"
    : "desktop";

  return { app, connectError, hostContext, mode, toolInput };
}
