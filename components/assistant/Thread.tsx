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
 * The empty state is taller than a phone screen, and the runtime can restore the scroll position
 * when the page mounts, which would open the app on the example cards with the orb and greeting
 * scrolled out of sight. Start at the top; sending a question then anchors it to the top of the list.
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

      {/* turnAnchor="top" pins the question to the top and lets the answer grow below it, instead of
          following the bottom of the list, which scrolled long answers past their first line.
          The library never anchors the very first turn, and its "first message appeared" jump to the
          bottom would hit exactly that turn, so it is off; there are no saved chats to restore. */}
      <ThreadPrimitive.Viewport
        className={styles.viewport}
        turnAnchor="top"
        scrollToBottomOnInitialize={false}
      >
        <div className={styles.viewportInner} role="log" aria-label="Conversation">
          <ThreadPrimitive.Empty>
            <EmptyState>
              <div className={styles.emptyHero}>
                <VoiceOrb phase="off" small />
              </div>
              <p className={styles.greeting}>Hello</p>
              <h2 className={styles.emptyTitle}>What can I help you with?</h2>
              <p className={styles.emptyLede}>
                <span className={styles.ledeFull}>
                  I analyze U.S. airports for terminal-expansion potential using a
                  transparent, rules-based scoring model over public aviation data.
                </span>
                {/* Two lines instead of three, for phones that are too short for the full sentence. */}
                <span className={styles.ledeShort}>
                  I analyze U.S. airports for terminal-expansion potential using transparent,
                  rules-based scoring.
                </span>
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
