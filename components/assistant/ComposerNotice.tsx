import styles from "./chat.module.css";

interface ComposerNoticeProps {
  message?: string | null;
  tone?: "info" | "error";
  /** Left-aligned and without the composer's side margins, for a notice that sits inside a message. */
  inline?: boolean;
  /** An optional link at the end of the line, e.g. to sign in again. */
  action?: { label: string; href: string };
}

/** A calm one-line status above the composer; renders nothing when there is nothing to say. */
export function ComposerNotice({ message, tone = "info", inline = false, action }: ComposerNoticeProps) {
  if (!message) return null;
  const classNames = [styles.notice, tone === "error" && styles.noticeError, inline && styles.noticeInline]
    .filter(Boolean)
    .join(" ");
  return (
    <p className={classNames} role="status" aria-live="polite">
      {message}
      {action && (
        <>
          {" "}
          <a className={styles.noticeLink} href={action.href}>
            {action.label}
          </a>
        </>
      )}
    </p>
  );
}
