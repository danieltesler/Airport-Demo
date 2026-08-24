"use client";

import { MessagePrimitive } from "@assistant-ui/react";
import styles from "./chat.module.css";

/** A user turn: a right-aligned bubble with the plain-text prompt. */
export function UserMessage() {
  return (
    <MessagePrimitive.Root className={styles.userRow}>
      <div className={styles.userBubble}>
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
