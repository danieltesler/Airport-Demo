import styles from "./chat.module.css";

interface ComposerNoticeProps {
  message?: string | null;
  tone?: "info" | "error";
}

/** A calm one-line status above the composer; renders nothing when there is nothing to say. */
export function ComposerNotice({ message, tone = "info" }: ComposerNoticeProps) {
  if (!message) return null;
  return (
    <p className={tone === "error" ? `${styles.notice} ${styles.noticeError}` : styles.notice} role="status" aria-live="polite">
      {message}
    </p>
  );
}
