import { type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { type ReactNode } from "react";
import styles from "./AppShell.module.css";
import { type LayoutMode } from "./host/layoutMode";

/** Insets the host reports for notches, home indicators, and rounded corners. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AppShellProps {
  mode: LayoutMode;
  /** Added to the card's padding so content clears device chrome. */
  safeAreaInsets?: SafeAreaInsets;
  /** Host display mode; fullscreen drops the card treatment. */
  displayMode?: McpUiDisplayMode;
  /** Buttons for the card's toolbar row — fullscreen, export, and the like. */
  actions?: ReactNode;
  children: ReactNode;
}

const BASE_PADDING: Record<LayoutMode, { x: number; y: number }> = {
  desktop: { x: 20, y: 24 },
  mobile: { x: 14, y: 16 },
};

/**
 * Card chrome every MCP app in this repo renders inside.
 *
 * Deliberately presentational: it takes the layout decisions the host hooks
 * produce rather than reaching for the host itself, so a new app can mount it
 * with nothing but props, and Storybook can render every state.
 */
export function AppShell({
  mode,
  safeAreaInsets,
  displayMode = "inline",
  actions,
  children,
}: AppShellProps) {
  const pad = BASE_PADDING[mode];
  return (
    <div
      className={styles.card}
      data-display-mode={displayMode}
      data-mode={mode}
      style={{
        paddingBottom: `calc(${pad.y}px + ${safeAreaInsets?.bottom ?? 0}px)`,
        paddingLeft: `calc(${pad.x}px + ${safeAreaInsets?.left ?? 0}px)`,
        paddingRight: `calc(${pad.x}px + ${safeAreaInsets?.right ?? 0}px)`,
        paddingTop: `calc(${pad.y}px + ${safeAreaInsets?.top ?? 0}px)`,
      }}
    >
      {actions && <div className={styles.toolbar}>{actions}</div>}
      {children}
    </div>
  );
}
