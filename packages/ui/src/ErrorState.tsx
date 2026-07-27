import styles from "./ErrorState.module.css";
import { RetryIcon } from "./icons";

export interface ErrorStateProps {
  /**
   * What went wrong, in the words of whoever knows: for a server tool failure
   * this is the server's own text, which is written to be actionable.
   */
  message: string;
  /** Heading for the block variant. Ignored by the banner. */
  title?: string;
  /** Omit to render without a retry affordance. */
  onRetry?: () => void;
  /** True while a retry is in flight. */
  retrying?: boolean;
  /**
   * `block` for a failure that leaves nothing to show; `banner` for one the
   * rest of the view survives.
   */
  variant?: "banner" | "block";
}

/** Surfaces a failure the user can read, and act on when a retry is possible. */
export function ErrorState({
  message,
  title = "Couldn't load this",
  onRetry,
  retrying,
  variant = "block",
}: ErrorStateProps) {
  return (
    <div className={styles.root} data-variant={variant} role="alert">
      <div>
        {variant === "block" && <div className={styles.title}>{title}</div>}
        <div className={styles.message}>{message}</div>
      </div>
      {onRetry && (
        <button
          className={styles.retry}
          disabled={retrying}
          onClick={onRetry}
          type="button"
        >
          <RetryIcon size={14} />
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
