"use client";

import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import type { AssistantExtras } from "@/lib/types";
import { StructuredResult } from "@/components/StructuredResult";
import { AssumptionsPanel } from "@/components/AssumptionsPanel";
import { useSpeechPlayback } from "@/hooks/useSpeechPlayback";
import { SIGN_IN_AGAIN_REPLY } from "@/lib/api";
import { ComposerNotice } from "./ComposerNotice";
import { MarkdownText } from "./MarkdownText";
import { TypingIndicator } from "./TypingIndicator";
import { SpeakerIcon, StopIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * An assistant turn. The reply text is rendered as Markdown by assistant-ui;
 * the non-text extras (structured table + assumptions panel) are read from the
 * message's `metadata.custom` — where the chat-model adapter stashed them — and
 * rendered beneath, so every answer keeps its supporting context. A
 * read-aloud control speaks the code-built summary (extras.spoken), not the prose.
 */
export function AssistantMessage() {
  const extras = useExtras();
  // A 401 is not a failure to explain: the session ended, so say so quietly and link to sign in.
  const needsSignIn = extras?.error === "unauthorized";
  const isError = !!extras?.error && !needsSignIn;
  const speechText = extras?.spoken ?? "";
  const { playback, player } = useSpeechPlayback();
  const isReadingThis = playback.text === speechText && playback.status !== "idle" && playback.status !== "error";

  return (
    <MessagePrimitive.Root className={styles.assistantRow}>
      <span className={styles.assistantMark} aria-hidden="true">
        ✦
      </span>

      <div className={styles.assistantBody}>
        {needsSignIn ? (
          <ComposerNotice inline message={SIGN_IN_AGAIN_REPLY} action={{ label: "Sign in", href: "/api/auth/login" }} />
        ) : (
          <div
            className={
              isError ? `${styles.assistantBubble} ${styles.errorBubble}` : styles.assistantBubble
            }
            role={isError ? "alert" : undefined}
          >
            {isError && <span className={styles.errorLabel}>Something went wrong</span>}
            <MessagePrimitive.Parts
              components={{ Text: MarkdownText, Empty: TypingIndicator }}
            />
          </div>
        )}

        {extras?.structured && <StructuredResult data={extras.structured} />}

        <AssumptionsPanel
          assumptions={extras?.assumptions}
          uncertainty={extras?.uncertainty}
          meta={extras?.meta}
        />

        {isError && (
          <ActionBarPrimitive.Root className={styles.messageActions}>
            <ActionBarPrimitive.Reload className={styles.actionButton}>
              <span>Try again</span>
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        )}

        {speechText && !isError && (
          <div className={styles.messageActions}>
            {isReadingThis ? (
              <button
                type="button"
                className={styles.actionButton}
                aria-label="Stop reading"
                onClick={() => player.cancel()}
              >
                <StopIcon />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className={styles.actionButton}
                aria-label="Read the spoken summary aloud"
                onClick={() => {
                  // Unlock inside the tap so the browser lets this clip play.
                  player.unlock();
                  player.speak(speechText);
                }}
              >
                <SpeakerIcon />
                <span>Read aloud</span>
              </button>
            )}
            <span className={styles.aiVoiceLabel}>AI voice</span>
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/** Read the extras the adapter attached to this message's metadata.custom. */
function useExtras(): AssistantExtras | undefined {
  return useAuiState((state) => state.message.metadata.custom) as
    | AssistantExtras
    | undefined;
}
