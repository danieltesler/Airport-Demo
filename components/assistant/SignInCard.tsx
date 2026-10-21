"use client";

import { CloseIcon } from "./icons";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { useSignInFailedNotice } from "./useSignInFailedNotice";
import styles from "./chat.module.css";

interface SignInCardProps {
  /** "start": first visit, no conversation yet. "continue": the session ended while a conversation is on screen. */
  variant: "start" | "continue";
}

const COPY = {
  start: {
    title: "Sign in to start",
    reason:
      "Sign in with your Google account to ask questions. We only use your name and email to keep the demo secure.",
  },
  continue: {
    title: "Sign in to continue",
    reason: "Your session ended. Sign in again to keep asking questions; your conversation stays on screen.",
  },
} as const;

/** Shown in place of the example cards and the composer when the server requires sign-in and nobody is signed in. */
export function SignInCard({ variant }: SignInCardProps) {
  const { visible: failedNoticeVisible, dismiss } = useSignInFailedNotice();
  const copy = COPY[variant];

  return (
    <div className={styles.signInArea}>
      {failedNoticeVisible && (
        <div className={styles.signInFailed} role="status">
          <span>Sign-in didn&apos;t complete. Please try again.</span>
          <button type="button" className={styles.signInFailedDismiss} aria-label="Dismiss" onClick={dismiss}>
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      )}
      <section className={styles.signInCard} aria-labelledby="sign-in-title">
        <h2 className={styles.signInTitle} id="sign-in-title">
          {copy.title}
        </h2>
        <p className={styles.signInReason}>{copy.reason}</p>
        <GoogleSignInButton />
      </section>
    </div>
  );
}
