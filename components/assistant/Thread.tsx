"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { AppHeader } from "./AppHeader";
import { ExampleChips } from "./ExampleChips";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { Composer } from "./Composer";
import { VoiceDisclosure } from "./VoiceDisclosure";
import { VoiceOrb } from "./VoiceOrb";
import styles from "./chat.module.css";

/**
 * The empty state is taller than a phone screen, and the runtime follows the bottom of the list,
 * which would open the app on the example cards with the orb and greeting scrolled out of sight.
 * Starting at the top is the same as the user having scrolled up, so sending a question still
 * brings the conversation back to the bottom.
 */
function EmptyState({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = ref.current?.closest(`.${styles.viewport}`);
    const scrollToTop = () => scroller?.scrollTo({ top: 0, behavior: "instant" });
    scrollToTop();
    const frame = requestAnimationFrame(() => requestAnimationFrame(scrollToTop));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} className={styles.empty}>
      {children}
    </div>
  );
}

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
        <div className={styles.viewportInner} role="log" aria-label="Conversation">
          <ThreadPrimitive.Empty>
            <EmptyState>
              <div className={styles.emptyHero}>
                <VoiceOrb phase="off" small />
              </div>
              <p className={styles.greeting}>Hello</p>
              <h2 className={styles.emptyTitle}>What can I help with?</h2>
              <p className={styles.emptyLede}>
                I analyze U.S. airports for terminal-expansion potential using a
                transparent, rules-based scoring model over public aviation data.
              </p>
              <span className={styles.tryLabel} id="try-asking">
                Try asking
              </span>
              <ExampleChips />
            </EmptyState>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      <div className={styles.composerBar}>
        <Composer />
        <VoiceDisclosure />
      </div>
    </ThreadPrimitive.Root>
  );
}
