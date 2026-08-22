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
  /**
   * The overlaid shot's reading at the same instant, when one is on screen.
   * Rendered after the primary value rather than as a second row: reading two
   * shots against each other is the whole reason to hover, and a row per series
   * per shot turns a four-line tooltip into eight.
   */
  comparison?: string;
}

export function TooltipEntry({
  color,
  label,
  value,
  unit,
  comparison,
}: TooltipEntryProps) {
  return (
    <div className={styles.entry}>
      <div className={styles.swatch} style={{ backgroundColor: color }} />
      <span className={styles.value}>
        <span className={styles.valueBold}>{value}</span>
        {comparison !== undefined && (
          // Tertiary at full strength, not the primary colour faded: stacked
          // opacity over secondary text composites to 3.4:1, under the 4.5:1
          // floor.
          <span className={styles.comparison}> vs {comparison}</span>
        )}{" "}
        <span className={styles.unit}>
          {unit ? `${unit} ` : ""}
          {label}
        </span>
      </span>
    </div>
  );
}
