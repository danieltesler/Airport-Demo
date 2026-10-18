/**
 * What the user's own message says about how many results, and in which direction. A model
 * routinely ignores "top 3" (returns its default 5) or answers "least congested" with a
 * descending ranking, so the code reads the user's words and wins over the model's arguments.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const PATTERNS = [
  /\btop\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:best|worst|top|most|least|biggest|busiest|largest|highest|lowest|smallest|fewest|strongest|weakest)\b/i,
  /\b(?:best|worst|busiest|biggest|largest|highest|lowest|strongest|weakest)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
];

/** "top 3", "3 best", "best three", "5 most congested": the number asked for, or null. */
export function requestedCount(message: string | undefined): number | null {
  // "the single best airport", "the busiest airport": one.
  if (/\b(?:single|one)\s+(?:best|worst|busiest|biggest|largest|highest|lowest)\b/i.test(message ?? "")) return 1;
  if (/\b(?:best|worst|busiest|biggest|largest|highest|lowest|most \w+|least \w+)\s+airport\b(?!s)/i.test(message ?? "")) return 1;
  for (const pattern of PATTERNS) {
    const match = (message ?? "").match(pattern);
    if (!match) continue;
    const raw = match[1].toLowerCase();
    const value = NUMBER_WORDS[raw] ?? Number(raw);
    if (Number.isInteger(value) && value >= 1) return value;
  }
  return null;
}

/** Ascending when the user asks for the least, lowest, fewest, smallest or bottom ("at least" does not count). */
export function requestedOrder(message: string | undefined): "asc" | "desc" | null {
  return /\b(?<!at )(least|lowest|fewest|smallest|bottom|quietest)\b/i.test(message ?? "") ? "asc" : null;
}
