import { type ReactNode } from "react";
import styles from "./Tooltip.module.css";

interface TooltipProps {
  timestamp?: string;
  children: ReactNode;
}

export function Tooltip({ timestamp, children }: TooltipProps) {
  return (
    <div className={styles.tooltip}>
      {children}
      {timestamp && <div className={styles.timestamp}>{timestamp}</div>}
    </div>
  );
}

interface TooltipEntryProps {
  color: string;
  label: string;
  value: string;
  unit?: string;
}

export function TooltipEntry({ color, label, value, unit }: TooltipEntryProps) {
  return (
    <div className={styles.entry}>
      <div className={styles.swatch} style={{ backgroundColor: color }} />
      <span className={styles.value}>
        <span className={styles.valueBold}>{value}</span>{" "}
        <span className={styles.unit}>
          {unit ? `${unit} ` : ""}
          {label}
        </span>
      </span>
    </div>
  );
}
