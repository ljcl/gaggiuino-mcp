import { type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

/** Which of the two layouts an app should render. */
export type LayoutMode = "mobile" | "desktop";

/**
 * Width (in px) below which an app renders in mobile layout.
 * Chosen to comfortably cover iPhone Pro Max (~430 CSS px), rotated iPads
 * in split view, and narrow desktop side panels where a desktop-density
 * layout would wrap and collide.
 */
export const MOBILE_BREAKPOINT_PX = 640;

/** The slice of host context that layout decisions are made from. */
export type LayoutHostContext = Pick<
  McpUiHostContext,
  "platform" | "containerDimensions" | "deviceCapabilities" | "userAgent"
>;

/**
 * Extract a width hint (in px) from host-reported container dimensions.
 * Supports both fixed `width` and bounded `maxWidth` forms per the MCP
 * Apps spec.
 */
export function widthFromHost(
  dims: McpUiHostContext["containerDimensions"],
): number | undefined {
  if (!dims) return undefined;
  if ("width" in dims && typeof dims.width === "number") return dims.width;
  if ("maxWidth" in dims && typeof dims.maxWidth === "number")
    return dims.maxWidth;
  return undefined;
}

/**
 * Decide whether to render the mobile layout. Combines every signal the
 * host is willing to give us:
 *
 * 1. Explicit `platform === "mobile"` (strongest)
 * 2. Touch-only device (touch && !hover) via deviceCapabilities
 * 3. Host-reported container width/maxWidth under the breakpoint
 * 4. Actual iframe `window.innerWidth` under the breakpoint (fallback)
 * 5. UA sniff for iPhone/iPad/Android (last resort)
 *
 * Any single signal triggers mobile. This is intentional: falsely rendering
 * mobile on desktop is a minor cosmetic issue, but falsely rendering desktop
 * on mobile squishes a dense layout into an unreadable state.
 *
 * @param userAgent - Fallback UA string when the host does not report one.
 *   Passed in rather than read off `navigator` so this stays a pure function.
 */
export function detectMobile(
  host: LayoutHostContext,
  viewportWidth: number,
  userAgent = "",
): boolean {
  if (host.platform === "mobile") return true;

  const caps = host.deviceCapabilities;
  if (caps?.touch === true && caps?.hover === false) return true;

  const hostWidth = widthFromHost(host.containerDimensions);
  if (hostWidth !== undefined && hostWidth < MOBILE_BREAKPOINT_PX) return true;

  if (viewportWidth < MOBILE_BREAKPOINT_PX) return true;

  return /iPhone|iPad|iPod|Android|Mobile/i.test(host.userAgent ?? userAgent);
}
