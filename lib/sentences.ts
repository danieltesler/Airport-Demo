/**
 * Abbreviation-safe sentence splitting, shared by the spoken-text builder and the
 * playback clip queue so both agree on what a sentence is. A wrong split mid-sentence
 * is the harmful error (the voice reads a fragment), so when unsure this does not split.
 */

// Always an abbreviation, whatever follows ("Dr. Smith").
const TITLES = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "mt", "ft", "jr", "sr", "vs", "sen", "rep", "gov", "gen"]);
// An abbreviation unless a capitalised word follows ("Acme Inc. The ...").
const TRAILING = new Set(["inc", "ltd", "co", "corp", "etc", "approx", "avg", "est", "dept", "ave", "blvd", "intl", "fig"]);
// "No. 5" is an abbreviation, "I said no." is not: decided by a digit following.
const NUMBER_WORDS = new Set(["no", "nos"]);

const INITIALISM = /^(?:[A-Za-z]\.)*[A-Za-z]$/; // "U.S", "e.g", "p.m", or a lone initial like "F"

function endsAbbreviation(before: string, after: string): boolean {
  const token = (before.match(/(\S+)$/)?.[1] ?? "").replace(/^[("'“‘[]+/, "");
  if (INITIALISM.test(token)) return true;

  const word = token.toLowerCase();
  const next = after.trimStart()[0] ?? "";
  if (TITLES.has(word)) return true;
  if (NUMBER_WORDS.has(word)) return /\d/.test(next);
  if (TRAILING.has(word)) return next !== "" && !/[A-Z]/.test(next);
  return false;
}

/** Split text into sentences at real boundaries; never splits "U.S.", "e.g.", "Dr.", "12.5" or similar. */
export function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const boundary = /([.!?]+)(\s+|$)/g;

  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    const end = match.index + match[1].length;
    const isSingleDot = match[1] === ".";
    if (isSingleDot && endsAbbreviation(text.slice(start, match.index), text.slice(boundary.lastIndex))) continue;
    sentences.push(text.slice(start, end).trim());
    start = boundary.lastIndex;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}
