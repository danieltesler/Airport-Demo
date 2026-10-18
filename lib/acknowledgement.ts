/**
 * The short "one moment" the voice says when an answer to a spoken question is slow to arrive.
 *
 * The four phrases are fixed text, fetched once from /api/tts on the first mic tap and kept in
 * memory (see warmClipCache), so playing one is instant, costs nothing per turn and can't say
 * anything unverified. It is skipped when the answer arrives first, and never repeats back to back.
 */

import { warmClipCache } from "./voicePlayback";

export const ACK_PHRASES = ["Sure, one moment.", "Let me check.", "Okay, looking that up.", "Good question, give me a second."] as const;
export const ACK_DELAY_MS = 1500;

let lastPhrase = -1;
let warmed = false;

/** A phrase other than the one used last time. */
export function pickAcknowledgement(random: () => number = Math.random): string {
  let index = Math.floor(random() * ACK_PHRASES.length);
  if (index === lastPhrase) index = (index + 1) % ACK_PHRASES.length;
  lastPhrase = index;
  return ACK_PHRASES[index];
}

export interface PendingAcknowledgement {
  /** Cancel the timer. Returns true if the acknowledgement had already started speaking. */
  stop(): boolean;
}

/** Speak an acknowledgement after `delayMs` unless `stop()` is called first. */
export function scheduleAcknowledgement(speak: (phrase: string) => void, delayMs: number = ACK_DELAY_MS): PendingAcknowledgement {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    speak(pickAcknowledgement());
  }, delayMs);
  return {
    stop() {
      clearTimeout(timer);
      return fired;
    },
  };
}

/** Fetch the phrases once per page, inside the user's first mic tap. Failures just mean a live fetch later. */
export function warmAcknowledgements(): void {
  if (warmed) return;
  warmed = true;
  void warmClipCache(ACK_PHRASES);
}

/** For tests. */
export function resetAcknowledgementState(): void {
  lastPhrase = -1;
  warmed = false;
}
