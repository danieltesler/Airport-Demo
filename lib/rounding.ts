/**
 * The one place numbers are rounded for display.
 *
 * Binary floating point stores 0.285 * 100 as 28.499999999999996, so a plain Math.round
 * rounds the "wrong" way on values that are exactly half. Every helper here first reads the
 * scaled value at 12 significant digits, which removes that noise, and only then rounds.
 */

/** Remove binary noise from a scaled value (28.499999999999996 -> 28.5). */
export const clean = (scaled: number): number => Number(scaled.toPrecision(12));

/** Round half up to `decimals` places (default 1), ignoring floating-point noise. */
export function roundTo(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(clean(value * factor)) / factor;
}

/**
 * Round `values` to `decimals` places so that they add up to exactly `total` (also expressed in
 * that precision's grid): each value is floored, then the remaining units go to the values with
 * the largest fractional parts, ties to the earlier value. Shares that must add to 100.0, or
 * score parts that must add to the displayed score, use this instead of rounding one by one.
 * Values must be non-negative and sum to `total` (to within rounding); none ever becomes negative.
 */
export function largestRemainder(values: number[], total: number, decimals = 1): number[] {
  const factor = 10 ** decimals;
  const scaled = values.map((value) => clean(value * factor));
  const floors = scaled.map((value) => Math.floor(value));
  let remaining = Math.round(clean(total * factor)) - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byFraction) {
    if (remaining <= 0) break;
    floors[index] += 1;
    remaining -= 1;
  }
  return floors.map((value) => value / factor);
}
