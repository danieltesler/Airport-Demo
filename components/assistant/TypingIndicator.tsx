import styles from "./chat.module.css";

/** Animated dots shown in the assistant bubble while an answer is pending. */
export function TypingIndicator() {
  return (
    <span className={styles.typing} aria-label="Analyzing" role="status">
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
    </span>
  );
}
