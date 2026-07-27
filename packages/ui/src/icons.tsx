/**
 * Inline icons for shell chrome.
 *
 * Inline rather than an icon package because MCP apps ship as a single HTML
 * file — every byte is inlined into the bundle the host loads. They are
 * decorative: the accessible name always comes from the button that wraps them.
 */

interface IconProps {
  size?: number;
}

function Svg({
  children,
  size = 16,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 16 16"
      width={size}
    >
      {children}
    </svg>
  );
}

/** Arrows pointing outward — enter fullscreen. */
export function ExpandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
    </Svg>
  );
}

/** Arrows pointing inward — leave fullscreen. */
export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" />
    </Svg>
  );
}

/** Tray with a downward arrow — save to a file. */
export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v8M5 7l3 3 3-3M2.5 13h11" />
    </Svg>
  );
}

/** Circular arrow — retry a failed request. */
export function RetryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 2v3.5H10" />
    </Svg>
  );
}
