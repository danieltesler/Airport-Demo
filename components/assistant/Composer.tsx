"use client";

import { ComposerPrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ComposerNotice } from "./ComposerNotice";
import { VoiceInput } from "./VoiceInput";
import { VoiceNoticeProvider, useVoiceNotice } from "./VoiceNoticeContext";
import { SendIcon, StopIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * Message input: a rounded pill with the text field, then icon-only controls (mic, the waveform
 * button that starts a conversation, and send, which becomes stop while an answer is running).
 * A calm line above the pill appears only when voice has something to say.
 */
export function Composer() {
  return (
    <VoiceNoticeProvider>
      <ComposerBody />
    </VoiceNoticeProvider>
  );
}

function ComposerBody() {
  const { notice } = useVoiceNotice();
  // The pastel waveform button and the black send button share one slot: waveform while empty, send once there is text.
  const hasText = useAuiState((state) => state.composer.text.trim().length > 0);

  return (
    <>
      <ComposerNotice message={notice?.message} tone={notice?.tone} />

      <ComposerPrimitive.Root className={styles.composer}>
        <ComposerPrimitive.Input
          className={styles.composerInput}
          placeholder="Ask something here…"
          rows={1}
          aria-label="Ask a question about U.S. airports"
        />

        <div className={styles.composerActions}>
          <VoiceInput hideConversationStart={hasText} />

          <ThreadPrimitive.If running={false}>
            {hasText && (
              <ComposerPrimitive.Send className={styles.sendButton} aria-label="Send message">
                <SendIcon />
              </ComposerPrimitive.Send>
            )}
          </ThreadPrimitive.If>

          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className={styles.sendButton} aria-label="Stop generating">
              <StopIcon />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
    </>
  );
}
