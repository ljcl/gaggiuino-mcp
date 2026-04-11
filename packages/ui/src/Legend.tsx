import styles from "./Legend.module.css";
import type { ReactNode } from "react";

interface LegendProps {
  children: ReactNode;
  /** "touch" bumps item vertical padding so tap targets meet mobile guidelines */
  size?: "default" | "touch";
}

export function Legend({ children, size = "default" }: LegendProps) {
  return (
    <div className={styles.legend} data-size={size}>
      {children}
    </div>
  );
}

interface LegendItemProps {
  color: string;
  label: string;
  hidden?: boolean;
  faded?: boolean;
  onClick?: () => void;
}

export function LegendItem({
  color,
  label,
  hidden,
  faded,
  onClick,
}: LegendItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={styles.legendButton}
      data-hidden={hidden || undefined}
      data-faded={faded || undefined}
    >
      <div className={styles.swatch} style={{ backgroundColor: color }} />
      <span>{label}</span>
    </button>
  );
}
