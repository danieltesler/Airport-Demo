import styles from "./TypingIndicator.module.css";

/** Animated three-dot indicator shown while the agent is composing a reply. */
export function TypingIndicator() {
  return (
    <div className={styles.row} aria-live="polite">
      <div className={styles.meta}>Analyst agent</div>
      <div className={styles.bubble}>
        <span className={styles.label}>Analyzing</span>
        <span className={styles.dots} aria-hidden="true">
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
        </span>
      </div>
    </div>
  );
}
