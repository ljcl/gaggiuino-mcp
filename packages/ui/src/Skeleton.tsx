import styles from "./Skeleton.module.css";

interface SkeletonProps {
  /** Variant changes the shape */
  variant?: "chart";
}

export function Skeleton({ variant = "chart" }: SkeletonProps) {
  return (
    <div className={styles.skeleton} data-variant={variant}>
      <div className={styles.chartArea} />
      <div className={styles.chartFooter}>
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
        <div className={styles.pillGhost} />
      </div>
    </div>
  );
}
