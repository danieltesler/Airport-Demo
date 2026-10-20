import { NewChatButton } from "./NewChatButton";
import styles from "./chat.module.css";

/** App header: a light wordmark with a small iridescent dot, a quiet pill saying what the data is, and New chat once there is a conversation. */
export function AppHeader() {
  return (
    <header className={styles.header}>
      <h1 className={styles.wordmark}>
        <span className={styles.wordmarkDot} aria-hidden="true" />
        <span>
          <span className={styles.wordmarkStrong}>Airport</span> Investment Intelligence
        </span>
      </h1>
      <div className={styles.headerActions}>
        <NewChatButton />
        <span className={styles.headerPill}>Public aviation data</span>
      </div>
    </header>
  );
}
