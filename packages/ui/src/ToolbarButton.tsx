import { type ReactNode } from "react";
import { type LayoutMode } from "./host/layoutMode";
import styles from "./ToolbarButton.module.css";

export interface ToolbarButtonProps {
  /** Accessible name and tooltip. The icon child is decorative. */
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** Set for toggle buttons so assistive tech reports the on/off state. */
  pressed?: boolean;
  mode?: LayoutMode;
}

/** Icon button for the {@link AppShell} toolbar. */
export function ToolbarButton({
  label,
  onClick,
  children,
  disabled,
  pressed,
  mode = "desktop",
}: ToolbarButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={styles.button}
      data-size={mode === "mobile" ? "touch" : undefined}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
