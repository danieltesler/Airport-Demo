/**
 * The anchor rule, as code. An anchor is the pair of raw values that map to 0 and 1 when
 * an input is scaled for scoring:
 *
 *   low  = 5th percentile of the input across every airport in the bundled dataset
 *   high = 95th percentile of the same
 *   both rounded outward to two significant figures (low down, high up).
 *
 * Percentiles use linear interpolation between order statistics (the spreadsheet
 * PERCENTILE.INC definition). lib/scoring.ts freezes the resulting numbers as constants so a
 * score means the same thing whatever scope is asked about; lib/anchors.test.ts re-derives
 * them from data/airports.json and fails if a data refresh has moved them.
 *
 * Pure module: no I/O.
 */

import { clean } from "./rounding";

export const ANCHOR_LOW_PERCENTILE = 0.05;
export const ANCHOR_HIGH_PERCENTILE = 0.95;
export const ANCHOR_SIGNIFICANT_FIGURES = 2;

export interface Anchor {
  /** Raw value that scales to 0 (and anything at or below it). */
  low: number;
  /** Raw value that scales to 1 (and anything at or above it). */
  high: number;
}

/** Linear-interpolated percentile (0 <= p <= 1) of a non-empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

export type RoundingDirection = "nearest" | "down" | "up";

const ROUNDERS: Record<RoundingDirection, (x: number) => number> = {
  nearest: Math.round,
  down: Math.floor,
  up: Math.ceil,
};

/**
 * Round to a number of significant figures: 0.07419 -> 0.074 (nearest), 0.8246 -> 0.83 (up),
 * -0.08328 -> -0.084 (down, i.e. towards minus infinity).
 */
export function roundSignificant(
  value: number,
  digits = ANCHOR_SIGNIFICANT_FIGURES,
  direction: RoundingDirection = "nearest",
): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const round = ROUNDERS[direction];
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const exponent = digits - 1 - magnitude;
  // Multiply/divide by a power of ten and clean binary noise BEFORE rounding directionally, so an
  // exact value such as 0.14 (0.14 * 100 = 14.000000000000002) is not pushed up a step; then clean
  // the result again (0.07300000000000001) by re-reading it at the requested precision.
  const rounded =
    exponent >= 0
      ? round(clean(value * 10 ** exponent)) / 10 ** exponent
      : round(clean(value / 10 ** -exponent)) * 10 ** -exponent;
  return Number(rounded.toPrecision(digits));
}

/**
 * Apply the anchor rule to one input's values (nulls are the caller's job to drop). Rounding
 * is outward -- the low anchor down, the high anchor up -- so rounding never pushes more
 * airports into the clamped tails than the percentiles themselves do.
 */
export function deriveAnchor(values: number[]): Anchor {
  return {
    low: roundSignificant(percentile(values, ANCHOR_LOW_PERCENTILE), ANCHOR_SIGNIFICANT_FIGURES, "down"),
    high: roundSignificant(percentile(values, ANCHOR_HIGH_PERCENTILE), ANCHOR_SIGNIFICANT_FIGURES, "up"),
  };
}

/** 0-1 position of a value between an anchor's low and high, clamped. */
export function scaleToAnchor(value: number, anchor: Anchor): number {
  const span = anchor.high - anchor.low;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (value - anchor.low) / span));
}
