import styles from "./chat.module.css";

/** App title bar: product name plus a one-line description of what it does. */
export function AppHeader() {
  return (
    <header className={styles.header}>
      <span className={styles.mark} aria-hidden="true">
        ✈
      </span>
      <div>
        <h1 className={styles.title}>Airport Investment Intelligence</h1>
        <p className={styles.subtitle}>
          Analyze U.S. airport capacity, congestion, and demand to find
          strong terminal-expansion candidates.
        </p>
      </div>
    </header>
  );
}
