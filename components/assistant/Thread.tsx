"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import { AppHeader } from "./AppHeader";
import { ExampleChips } from "./ExampleChips";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { Composer } from "./Composer";
import styles from "./chat.module.css";

/**
 * The whole chat surface: header, a scrolling message viewport with an empty
 * state (lede + example prompts), and a pinned composer. All chat behavior
 * (transcript, history, streaming, voice) comes from the assistant-ui runtime.
 */
export function Thread() {
  return (
    <ThreadPrimitive.Root className={styles.root}>
      <AppHeader />

      <ThreadPrimitive.Viewport className={styles.viewport}>
        <div className={styles.viewportInner}>
          <ThreadPrimitive.Empty>
            <div className={styles.empty}>
              <p className={styles.emptyLede}>
                I analyze U.S. airports for terminal-expansion potential using a
                transparent, rules-based scoring model over public aviation data.
              </p>
              <span className={styles.tryLabel}>Try asking</span>
              <ExampleChips />
            </div>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      <div className={styles.composerBar}>
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
}
