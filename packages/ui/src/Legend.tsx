import { type ReactNode } from "react";
import styles from "./Legend.module.css";

interface LegendProps {
  children: ReactNode;
  /** "touch" bumps item vertical padding so tap targets meet mobile guidelines */
  size?: "default" | "touch";
  /** Accessible name for the group, e.g. "Comparison shot series". */
  label?: string;
}

/**
 * A list, not a bare row of buttons: a legend *is* an enumeration of series,
 * and the semantics come for free — a screen reader announces how many entries
 * there are, and `aria-label` names the set, which is what tells someone that
 * "Pressure (cmp)" belongs to the comparison shot rather than the primary one.
 */
export function Legend({ children, label, size = "default" }: LegendProps) {
  return (
    <ul aria-label={label} className={styles.legend} data-size={size}>
      {children}
    </ul>
  );
}

interface LegendItemProps {
  color: string;
  label: string;
  hidden?: boolean;
  faded?: boolean;
  /**
   * SVG `stroke-dasharray` for the series this item toggles. The swatch draws
   * it, so the legend teaches the same non-color encoding the chart uses —
   * without it, a viewer who cannot separate two series by hue has no key.
   */
  dash?: string;
  onClick?: () => void;
}

export function LegendItem({
  color,
  dash,
  label,
  hidden,
  faded,
  onClick,
}: LegendItemProps) {
  return (
    <li className={styles.item}>
      <button
        // A legend entry is a toggle, and "pressed" is the only thing that
        // tells a screen reader whether the series is currently on the chart.
        // The strikethrough that says so visually is invisible to assistive
        // tech.
        aria-pressed={!hidden}
        className={styles.legendButton}
        data-faded={faded || undefined}
        data-hidden={hidden || undefined}
        onClick={onClick}
        type="button"
      >
        <svg aria-hidden="true" className={styles.swatch} focusable="false">
          <line
            stroke={color}
            strokeDasharray={dash}
            strokeLinecap="round"
            strokeWidth={3}
            x1={1}
            x2={17}
            y1={1.5}
            y2={1.5}
          />
        </svg>
        <span>{label}</span>
      </button>
    </li>
  );
}
