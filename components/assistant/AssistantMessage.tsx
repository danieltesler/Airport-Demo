"use client";

import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import type { AssistantExtras } from "@/lib/types";
import { StructuredResult } from "@/components/StructuredResult";
import { AssumptionsPanel } from "@/components/AssumptionsPanel";
import { useSpeechSupport } from "@/hooks/useSpeechSupport";
import { MarkdownText } from "./MarkdownText";
import { TypingIndicator } from "./TypingIndicator";
import { SpeakerIcon, StopIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * An assistant turn. The reply text is rendered as Markdown by assistant-ui;
 * the non-text extras (structured table + assumptions panel) are read from the
 * message's `metadata.custom` — where the chat-model adapter stashed them — and
 * rendered beneath, so every answer keeps its supporting context. A
 * read-aloud control is shown when the browser supports speech synthesis.
 */
export function AssistantMessage() {
  const extras = useExtras();
  const hasText = useHasText();
  const { synthesis } = useSpeechSupport();

  return (
    <MessagePrimitive.Root className={styles.assistantRow}>
      <span className={styles.assistantMark} aria-hidden="true">
        ✦
      </span>

      <div className={styles.assistantBody}>
        <div className={styles.assistantBubble}>
          <MessagePrimitive.Parts
            components={{ Text: MarkdownText, Empty: TypingIndicator }}
          />
        </div>

        {extras?.structured && <StructuredResult data={extras.structured} />}

        <AssumptionsPanel
          assumptions={extras?.assumptions}
          uncertainty={extras?.uncertainty}
          meta={extras?.meta}
        />

        {synthesis && hasText && (
          <ActionBarPrimitive.Root className={styles.messageActions}>
            <MessagePrimitive.If speaking={false}>
              <ActionBarPrimitive.Speak
                className={styles.actionButton}
                aria-label="Read this answer aloud"
              >
                <SpeakerIcon />
                <span>Read aloud</span>
              </ActionBarPrimitive.Speak>
            </MessagePrimitive.If>

            <MessagePrimitive.If speaking>
              <ActionBarPrimitive.StopSpeaking
                className={styles.actionButton}
                aria-label="Stop reading"
              >
                <StopIcon />
                <span>Stop</span>
              </ActionBarPrimitive.StopSpeaking>
            </MessagePrimitive.If>
          </ActionBarPrimitive.Root>
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

/** True once the reply has rendered text (i.e. it is no longer just pending). */
function useHasText(): boolean {
  return useAuiState((state) =>
    state.message.content.some(
      (part) => part.type === "text" && part.text.length > 0
    )
  );
}

