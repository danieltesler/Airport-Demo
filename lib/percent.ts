/**
 * One way to show a ratio as a percentage in tables, so a figure reads the same in every table
 * and in the prose that cites it (79.85% shows as 79.9%, never as a lossy 0.8).
 */

/** A ratio rounded half up to one decimal place of percent, e.g. 0.7985 -> 79.9; null stays null. */
export function percentValue(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  // toPrecision strips binary noise (0.7985 * 1000 = 798.4999...) before rounding.
  return Math.round(Number((ratio * 1000).toPrecision(12))) / 10;
}

/** Table text such as "79.9%"; null when the source value is missing. */
export function percentText(ratio: number | null | undefined): string | null {
  const value = percentValue(ratio);
  return value === null ? null : `${value.toFixed(1)}%`;
}
