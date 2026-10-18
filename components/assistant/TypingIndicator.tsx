import styles from "./chat.module.css";

/** Animated dots plus a text label while an answer is pending (label keeps it clear without motion). */
export function TypingIndicator() {
  return (
    <span className={styles.typing} role="status">
      <span className={styles.typingDot} aria-hidden="true" />
      <span className={styles.typingDot} aria-hidden="true" />
      <span className={styles.typingDot} aria-hidden="true" />
      <span className={styles.typingLabel}>Analyzing airport data…</span>
    </span>
  );
}
