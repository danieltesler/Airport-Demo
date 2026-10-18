/** Pure logic for the voice orb and overlay: what each phase looks like and what a tap does. */

export type OrbPhase = "off" | "starting" | "listening" | "thinking" | "speaking" | "paused";

export type OrbAction = "interrupt" | "continue" | null;

/** Plain-word status shown under the orb when the caller gives no text of its own. */
export const DEFAULT_STATUS: Record<OrbPhase, string> = {
  off: "Ready",
  starting: "Getting ready",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
};

/** Visual states the stylesheet knows. Off and starting share the calm idle look. */
export type OrbVisual = "idle" | "listening" | "thinking" | "speaking" | "paused";

export function orbVisual(phase: OrbPhase): OrbVisual {
  if (phase === "off" || phase === "starting") return "idle";
  return phase;
}

export const statusFor = (phase: OrbPhase, statusText?: string): string =>
  statusText?.trim() ? statusText.trim() : DEFAULT_STATUS[phase];

/** What tapping the orb does. Continue wins: a paused conversation must be easy to resume. */
export function orbAction(
  phase: OrbPhase,
  options: { canInterrupt?: boolean; needsContinue?: boolean } = {},
): OrbAction {
  if (options.needsContinue ?? phase === "paused") return "continue";
  if (options.canInterrupt ?? phase === "speaking") return "interrupt";
  return null;
}

export const ORB_ACTION_LABEL: Record<Exclude<OrbAction, null>, string> = {
  interrupt: "Interrupt",
  continue: "Tap to continue",
};

/** A speech level from the caller can be anything; the orb accepts only 0-1, and none when motion is reduced. */
export function orbLevel(level: number | undefined, reducedMotion: boolean): number {
  if (reducedMotion || level === undefined || !Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

const NEWEST_WORDS = 3;
const MAX_TRANSCRIPT_CHARS = 140;

/** Only the tail of a long transcript fits the screen; cut at a word boundary and mark the cut. */
export function tailTranscript(text: string, maxChars = MAX_TRANSCRIPT_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(clean.length - maxChars);
  const firstSpace = tail.indexOf(" ");
  return `…${firstSpace === -1 ? tail : tail.slice(firstSpace + 1)}`;
}

/** Splits a transcript into the words already said (shown light) and the newest words (shown dark). */
export function splitTranscript(text: string, newestWords = NEWEST_WORDS): { said: string; newest: string } {
  const words = tailTranscript(text).split(" ").filter(Boolean);
  const cut = Math.max(0, words.length - newestWords);
  return { said: words.slice(0, cut).join(" "), newest: words.slice(cut).join(" ") };
}
