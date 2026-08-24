"use client";

import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { VoiceInput } from "./VoiceInput";
import { SendIcon, StopIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * Message input: a growing textarea, mic dictation with a language toggle
 * (shown only where the browser supports SpeechRecognition), and a send button
 * that becomes a cancel button while an answer is streaming in.
 */
export function Composer() {
  return (
    <ComposerPrimitive.Root className={styles.composer}>
      <ComposerPrimitive.Input
        className={styles.composerInput}
        placeholder="Ask about airport capacity, congestion, or demand…"
        rows={1}
      />

      <div className={styles.composerActions}>
        <VoiceInput />

        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send
            className={styles.sendButton}
            aria-label="Send message"
          >
            <SendIcon />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>

        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel
            className={styles.sendButton}
            aria-label="Stop generating"
          >
            <StopIcon />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
}
