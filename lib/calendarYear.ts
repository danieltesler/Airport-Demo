/**
 * Does the user ask for calendar-year figures ("in 2025", "2025 vs 2024", "last year")? Those come from
 * the dataset (airport_profile), never from the live BTS summary, whose window is a trailing 12 months
 * that does not line up with a calendar year.
 */

const CALENDAR_YEAR = /\b(?:in|during|for|from|of|versus|vs\.?|against|than)\s+(?:2024|2025)\b|\b(?:2024|2025)\s+(?:vs\.?|versus|compared)|\blast year\b|\bcalendar[- ]year\b|\bprevious year\b|\byear[- ]over[- ]year\b/i;
const WANTS_RECENT = /\b(trailing|latest|most recent|recent(?:ly)?|last 12 months|past 12 months|past year|12 months|live)\b/i;

export function asksForCalendarYear(message: string | undefined): boolean {
  const text = message ?? "";
  return CALENDAR_YEAR.test(text) && !WANTS_RECENT.test(text);
}
