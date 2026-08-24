"use client";

import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { dirFor } from "@/lib/i18n";
import styles from "./chat.module.css";

/** A user turn: a right-aligned bubble whose text direction follows its language. */
export function UserMessage() {
  const text = useAuiState((state) =>
    state.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );

  return (
    <MessagePrimitive.Root className={styles.userRow}>
      <div className={styles.userBubble} dir={dirFor(text)}>
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
