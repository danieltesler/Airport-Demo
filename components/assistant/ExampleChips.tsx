"use client";

import type { ComponentType, SVGProps } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { CompareIcon, PieIcon, PlaneIcon, RadarIcon, TrendIcon } from "./icons";
import styles from "./chat.module.css";

interface ExampleCard {
  prompt: string;
  title: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Starter prompts as cards; the last one exercises the live ADS-B tool. The prompt text is what gets sent. */
const EXAMPLE_CARDS: ExampleCard[] = [
  {
    prompt: "Which airports in New England are strong candidates for terminal expansion?",
    title: "Expansion candidates",
    Icon: TrendIcon,
  },
  { prompt: "Compare LA and Santa Ana airport congestion levels.", title: "Compare congestion", Icon: CompareIcon },
  {
    prompt: "What is the percentage of long-haul flights out of Anchorage airport?",
    title: "Long-haul share",
    Icon: PlaneIcon,
  },
  { prompt: "What is the unmet flight demand in SFO airport and why?", title: "Unmet demand", Icon: PieIcon },
  { prompt: "How many aircraft are in the air around Atlanta right now?", title: "Live traffic", Icon: RadarIcon },
];

export const EXAMPLE_QUESTIONS: string[] = EXAMPLE_CARDS.map((card) => card.prompt);

/**
 * Clickable starter cards. Each is a thread suggestion that submits its question
 * immediately (`send`) through the runtime.
 */
export function ExampleChips() {
  return (
    <div className={styles.chips} role="group" aria-labelledby="try-asking">
      {EXAMPLE_CARDS.map((card) => (
        <ThreadPrimitive.Suggestion key={card.prompt} prompt={card.prompt} send className={styles.chip}>
          <span className={styles.chipIcon} aria-hidden="true">
            <card.Icon width={20} height={20} strokeWidth={1.75} />
          </span>
          <span className={styles.chipText}>
            <span className={styles.chipTitle}>{card.title}</span>
            <span className={styles.chipDescription}>{card.prompt}</span>
          </span>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}
