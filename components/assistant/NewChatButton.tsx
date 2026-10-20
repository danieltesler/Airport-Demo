"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { getSpeechPlayer } from "@/lib/voicePlayback";
import { bumpVoiceEpoch } from "@/lib/voiceSession";
import { PlusIcon } from "./icons";
import { startNewChat } from "./newChat";
import styles from "./chat.module.css";

/**
 * Ghost pill in the header that discards the conversation and returns to the home screen.
 * Not rendered on the empty home screen, where there is nothing to start over from.
 */
export function NewChatButton() {
  const aui = useAui();
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);
  if (!hasMessages) return null;

  const handleClick = () =>
    startNewChat(aui.thread(), () => {
      bumpVoiceEpoch(); // an answer still on its way is stale: it must not be spoken in the new chat
      getSpeechPlayer().cancel("new chat");
    });

  return (
    <button type="button" className={styles.newChatButton} aria-label="New chat" onClick={handleClick}>
      <PlusIcon />
      <span className={styles.newChatLabel}>New chat</span>
    </button>
  );
}
