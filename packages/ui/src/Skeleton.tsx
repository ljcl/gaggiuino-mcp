import styles from "./Skeleton.module.css";

interface SkeletonProps {
  /** Variant changes the shape */
  variant?: "chart";
  /**
   * Optional status line under the placeholder, for when a fetch has been
   * running long enough that a silent shimmer starts to look like a hang.
   */
  message?: string;
}

export function Skeleton({ variant = "chart", message }: SkeletonProps) {
  return (
    <div className={styles.skeleton} data-variant={variant}>
      <div className={styles.chartArea} />
      <div className={styles.chartFooter}>
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
      </div>
      {message && (
        <div className={styles.message} role="status">
          {message}
        </div>
      )}
    </div>
  );
}
