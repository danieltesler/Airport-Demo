import styles from "./Header.module.css";

/** App title bar with a one-line description of what the agent does. */
export function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          ✈
        </span>
        <div>
          <h1 className={styles.title}>Airport Investment Intelligence</h1>
          <p className={styles.subtitle}>
            Ask about capacity, congestion, demand, and expansion candidates
            across U.S. airports.
          </p>
        </div>
      </div>
    </header>
  );
}
