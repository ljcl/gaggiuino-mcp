import styles from "./ShotHeader.module.css";
import type { ShotMeta } from "./types";

function MetaSummary({ meta }: { meta: ShotMeta }) {
  return (
    <div>
      <div className={styles.title}>{meta.profileName}</div>
      <div className={styles.subtitle}>
        {meta.weight.toFixed(1)}g in {meta.duration.toFixed(1)}s
      </div>
    </div>
  );
}

/**
 * Compact single-line meta summary for mobile comparison header. Uses a
 * bold profile name inline with the weight/duration to save vertical space.
 */
function InlineMetaSummary({
  meta,
  prefix,
}: {
  meta: ShotMeta;
  prefix?: string;
}) {
  return (
    <div className={styles.inlineSummary}>
      {prefix && <span className={styles.inlinePrefix}>{prefix}</span>}
      <span className={styles.inlineTitle}>{meta.profileName}</span>
      <span className={styles.inlineSubtitle}>
        {meta.weight.toFixed(1)}g in {meta.duration.toFixed(1)}s
      </span>
    </div>
  );
}

interface ShotHeaderProps {
  primary: ShotMeta;
  comparison?: ShotMeta;
  onRequestCompare?: () => void;
  onDismissCompare?: () => void;
  compareLoading?: boolean;
  mode: "mobile" | "desktop";
}

export function ShotHeader({
  primary,
  comparison,
  onRequestCompare,
  onDismissCompare,
  compareLoading,
  mode,
}: ShotHeaderProps) {
  if (mode === "mobile") {
    return (
      <div className={styles.mobileRoot}>
        {!comparison && <MetaSummary meta={primary} />}
        {!comparison && onRequestCompare && (
          <button
            type="button"
            onClick={onRequestCompare}
            disabled={compareLoading}
            className={`${styles.button} ${styles.mobileCompareButton}`}
            data-loading={compareLoading || undefined}
          >
            {compareLoading ? "Loading..." : "Compare previous"}
          </button>
        )}
        {comparison && (
          <div className={styles.mobileComparisonStack}>
            <InlineMetaSummary meta={primary} />
            <div className={styles.mobileComparisonRow}>
              <InlineMetaSummary meta={comparison} prefix="vs" />
              {onDismissCompare && (
                <button
                  type="button"
                  onClick={onDismissCompare}
                  aria-label="Dismiss comparison"
                  className={`${styles.button} ${styles.mobileDismissButton}`}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={styles.desktopRoot}
      data-comparison={comparison ? true : undefined}
    >
      <div className={styles.desktopPrimary}>
        <MetaSummary meta={primary} />
        {!comparison && onRequestCompare && (
          <button
            type="button"
            onClick={onRequestCompare}
            disabled={compareLoading}
            className={`${styles.button} ${styles.desktopCompareButton}`}
            data-loading={compareLoading || undefined}
          >
            {compareLoading ? "Loading..." : "Compare previous"}
          </button>
        )}
      </div>
      {comparison && (
        <div className={styles.desktopComparison}>
          <MetaSummary meta={comparison} />
          {onDismissCompare && (
            <button
              type="button"
              onClick={onDismissCompare}
              className={`${styles.button} ${styles.desktopDismissButton}`}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
