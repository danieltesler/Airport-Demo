"use client";

import type { ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useAuthStatus } from "./AuthStatusProvider";
import { SignInCard } from "./SignInCard";
import { VoiceDisclosure } from "./VoiceDisclosure";
import styles from "./chat.module.css";

/** An invisible stand-in with the composer's pill and privacy line, so the page is the same height before and after the server answers. */
function ComposerPlaceholder() {
  return (
    <div className={styles.composerPending} aria-hidden="true">
      <div className={styles.composer}>
        <div className={styles.composerPendingRow} />
      </div>
      <VoiceDisclosure />
    </div>
  );
}

/**
 * Shows its children (the composer) unless the server requires sign-in and nobody is signed in.
 * This only decides what to display: the API routes refuse unsigned requests on their own
 * (lib/auth/session.ts), whatever this renders.
 *
 * On the home screen the sign-in card lives in the empty state (see HomeStart), so this renders
 * nothing there. Once a conversation exists (the session ended mid-chat) the card takes the composer's place.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthStatus();
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);

  // Not known yet: reserve the composer's height rather than flash the composer at someone who must
  // sign in, so the page does not shift when the answer arrives.
  if (!auth) return <ComposerPlaceholder />;
  if (!auth.required || auth.signedIn) return <>{children}</>;
  if (!hasMessages) return null;
  return <SignInCard variant="continue" />;
}
