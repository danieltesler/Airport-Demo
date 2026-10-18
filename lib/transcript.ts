/**
 * Is a transcript worth sending to the assistant? Speech recognition returns text even for
 * silence or a cough, and the usual ghosts are "Thank you." and "you". In hands-free mode a ghost
 * would send a question nobody asked, so the clip is treated as "didn't catch that" instead.
 */

const FILLER = new Set(["you", "thank you", "thanks", "thanks for watching", "bye", "bye bye", "okay", "ok", "hmm", "um", "uh", "mm", "the"]);

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const wordCount = (text: string): number => (normalise(text) ? normalise(text).split(" ").length : 0);

/** True when the text is empty, only filler, or (when `minWords` is set) shorter than that. */
export function isGhostTranscript(text: string, minWords = 1): boolean {
  const clean = normalise(text);
  if (!clean) return true;
  if (FILLER.has(clean)) return true;
  return wordCount(clean) < minWords;
}
