"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import styles from "./chat.module.css";

/** Sample analyst questions offered as starting points; the last one exercises the live ADS-B tool. */
export const EXAMPLE_QUESTIONS: string[] = [
  "Which airports in New England are strong candidates for terminal expansion?",
  "Compare LA and Santa Ana airport congestion levels.",
  "What is the percentage of long-haul flights out of Anchorage airport?",
  "What is the unmet flight demand in SFO airport and why?",
  "How many aircraft are in the air around Atlanta right now?",
];

/**
 * Clickable starter prompts. Each chip is a thread suggestion that submits the
 * question immediately (`send`) through the runtime.
 */
export function ExampleChips() {
  return (
    <div className={styles.chips} role="group" aria-labelledby="try-asking">
      {EXAMPLE_QUESTIONS.map((question) => (
        <ThreadPrimitive.Suggestion
          key={question}
          prompt={question}
          send
          className={styles.chip}
        >
          {question}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}
