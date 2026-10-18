import styles from "./chat.module.css";

/** App header: a light wordmark with a small iridescent dot, and a quiet pill saying what the data is. */
export function AppHeader() {
  return (
    <header className={styles.header}>
      <h1 className={styles.wordmark}>
        <span className={styles.wordmarkDot} aria-hidden="true" />
        <span>
          <span className={styles.wordmarkStrong}>Airport</span> Investment Intelligence
        </span>
      </h1>
      <span className={styles.headerPill}>Public aviation data</span>
    </header>
  );
}
