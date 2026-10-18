/**
 * Voice transcripts spell airport codes out: "L A X", "S.N.A.", "J-F-K". Collapse a run of exactly
 * three single letters into the code before any parsing, so "Compare L A X and Santa Ana" is
 * read as LAX and Santa Ana instead of an unknown place.
 */

const SPELLED = /(?<![A-Za-z])([A-Za-z])[ .-]([A-Za-z])[ .-]([A-Za-z])\.?(?![A-Za-z])/g;

export function collapseSpelledLetters(text: string): string {
  return text.replace(SPELLED, (_, a: string, b: string, c: string) => `${a}${b}${c}`.toUpperCase());
}
