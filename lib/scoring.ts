/**
 * Deterministic scoring engine for airport investment analysis.
 *
 * This module is the analytical core of the agent. It has **no LLM calls and no
 * I/O** — just pure functions over airport metric objects. That separation is
 * deliberate: the numbers an analyst sees must be reproducible and auditable,
 * independent of any language-model output.
 *
 * Design choices (see docs/DESIGN.md for the full rationale):
 *  - Every sub-metric is normalized to 0-1 against a **fixed, documented reference
 *    scale** (e.g. "30 min average delay = fully congested"), not against the
 *    current dataset's distribution. Fixed scales keep a score meaning the same
 *    thing regardless of which airports are loaded.
 *  - Composite scores are simple **transparent weighted sums** on a 0-100 scale.
 *    Weights live in one place and are easy to defend.
 *  - Each scorer returns not just a number but its **components** and the
 *    **assumptions** behind it, so the agent can explain itself and stay honest.
 */

import type { Airport } from "./data";

// --------------------------------------------------------------------------- //
// Reference scales — the anchors that turn raw metrics into 0-1 components.
// Chosen from domain norms; documented so a reviewer can challenge any one value.
// --------------------------------------------------------------------------- //

export const FULL_CONGESTION_DELAY_MIN = 30.0; // avg departure delay treated as "saturated"
export const FULL_CONGESTION_DELAYED_SHARE = 0.35; // share >15 min late at saturation
export const FULL_CONGESTION_CANCEL_RATE = 0.05; // cancellation rate at saturation
export const LOAD_FACTOR_FLOOR = 0.7; // below this, seats are not a constraint
export const LOAD_FACTOR_CEILING = 0.9; // at/above this, effectively sold out

export const STRONG_GROWTH_YOY = 0.1; // 10% YoY growth = maximal demand signal
export const LARGE_AIRPORT_PAX = 50_000_000; // passengers at which volume upside maxes out
export const HIGH_THROUGHPUT_PER_RUNWAY = 60_000; // departures/runway treated as runway-constrained

export function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

/** Map a raw value onto 0-1 where `fullScale` maps to 1.0. */
export function normalize(value: number, fullScale: number): number {
  if (fullScale <= 0) return 0;
  return clamp(value / fullScale);
}

/**
 * Seat-supply pressure on 0-1. Below the floor there is spare capacity (0); at/above
 * the ceiling the airport is effectively full (1); linear in between.
 */
export function loadFactorPressure(loadFactor: number): number {
  const span = LOAD_FACTOR_CEILING - LOAD_FACTOR_FLOOR;
  return clamp((loadFactor - LOAD_FACTOR_FLOOR) / span);
}

export type MetricKey = "congestion" | "unmet_demand" | "expansion";

/** A score plus the components and assumptions that produced it. */
export interface ScoreResult {
  score: number; // 0-100
  components: Record<string, number>; // named 0-1 contributions
  assumptions: string[];
  uncertainty: string | null;
}

const round = (n: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Round a ScoreResult for transport (mirrors the Python `as_dict`). */
export function roundResult(result: ScoreResult): ScoreResult {
  const components: Record<string, number> = {};
  for (const [k, v] of Object.entries(result.components)) components[k] = round(v, 3);
  return { ...result, score: round(result.score, 1), components };
}

// --------------------------------------------------------------------------- //
// Congestion
// --------------------------------------------------------------------------- //

export const CONGESTION_WEIGHTS: Record<string, number> = {
  delayed_share: 0.35,
  avg_delay: 0.3,
  cancellations: 0.15,
  load_pressure: 0.2,
};

const CONGESTION_ASSUMPTIONS = [
  "Congestion is proxied by operational strain: departure delays, the share of " +
    "flights delayed >15 min, cancellations, and seat load factor.",
  "Metrics are compared as rates (per-flight / per-seat), not totals, so large " +
    "hubs and small airports are judged on the same footing.",
];

export function congestionScore(a: Airport): ScoreResult {
  const components = {
    delayed_share: normalize(a.delayed_share, FULL_CONGESTION_DELAYED_SHARE),
    avg_delay: normalize(a.avg_dep_delay_min, FULL_CONGESTION_DELAY_MIN),
    cancellations: normalize(a.cancel_rate, FULL_CONGESTION_CANCEL_RATE),
    load_pressure: loadFactorPressure(a.load_factor),
  };
  const score =
    100 *
    Object.entries(CONGESTION_WEIGHTS).reduce(
      (sum, [k, w]) => sum + w * components[k as keyof typeof components],
      0,
    );
  return {
    score,
    components,
    assumptions: CONGESTION_ASSUMPTIONS,
    uncertainty:
      "Delay data reflects annual averages; short-term peaks (holidays, weather " +
      "events) are smoothed out. Delays also mix weather with true capacity saturation.",
  };
}

// --------------------------------------------------------------------------- //
// Long-haul mix
// --------------------------------------------------------------------------- //

export function haulBreakdown(a: Airport): { short: number; medium: number; long: number } {
  return {
    short: round(100 * a.haul_mix.short),
    medium: round(100 * a.haul_mix.medium),
    long: round(100 * a.haul_mix.long),
  };
}

// --------------------------------------------------------------------------- //
// Unmet demand
// --------------------------------------------------------------------------- //

export const UNMET_DEMAND_WEIGHTS: Record<string, number> = {
  load_pressure: 0.4, // high load factor => spilled demand
  congestion: 0.35, // delay/throughput gap => demand above capacity
  growth_vs_capacity: 0.25, // fast growth against fixed runways => widening gap
};

const UNMET_DEMAND_ASSUMPTIONS = [
  "'Unmet demand' has no direct public measurement (bookings that never happened " +
    "aren't observable in free data). We estimate it as a composite lower-bound proxy.",
  "Load factor is the primary signal: sustained high seat utilization implies " +
    "demand that current supply cannot absorb.",
  "Growth measured against roughly fixed runway capacity indicates a widening gap.",
];

/** 0-1: fast passenger growth relative to runway throughput headroom. */
export function growthVsCapacity(a: Airport): number {
  const growth = normalize(a.pax_growth_yoy, STRONG_GROWTH_YOY);
  const throughputPerRunway = a.annual_departures / Math.max(a.runways, 1);
  const runwayPressure = normalize(throughputPerRunway, HIGH_THROUGHPUT_PER_RUNWAY);
  // A widening gap needs BOTH growing demand and limited headroom.
  return clamp(0.6 * growth + 0.4 * runwayPressure);
}

export function unmetDemandScore(a: Airport): ScoreResult {
  const congestion = congestionScore(a).score / 100;
  const components = {
    load_pressure: loadFactorPressure(a.load_factor),
    congestion,
    growth_vs_capacity: growthVsCapacity(a),
  };
  const score =
    100 *
    Object.entries(UNMET_DEMAND_WEIGHTS).reduce(
      (sum, [k, w]) => sum + w * components[k as keyof typeof components],
      0,
    );
  return {
    score,
    components,
    assumptions: UNMET_DEMAND_ASSUMPTIONS,
    uncertainty:
      "This is a lower-bound proxy. True unmet demand (searches that didn't convert, " +
      "fares that priced people out) requires proprietary GDS/OAG data not available for free.",
  };
}

// --------------------------------------------------------------------------- //
// Expansion attractiveness — the headline investment score
// --------------------------------------------------------------------------- //

export const EXPANSION_WEIGHTS: Record<string, number> = {
  demand_growth: 0.3, // future demand to justify the build
  congestion: 0.3, // today's strain that expansion would relieve
  load_pressure: 0.25, // seats already scarce
  volume_upside: 0.15, // scale of passengers who benefit
};

export const EXPANSION_ASSUMPTIONS = [
  "Investment thesis: terminal expansion is most profitable where strong, growing " +
    "demand meets a capacity-constrained airport — so renovation unlocks revenue " +
    "rather than adding idle space.",
  "Score blends demand growth, current congestion, seat load pressure, and passenger " +
    "volume; weights are documented and adjustable.",
  "Airport scope is limited to the bundled dataset (major + selected mid-size U.S. airports).",
];

export function expansionScore(a: Airport): ScoreResult {
  const components = {
    demand_growth: normalize(a.pax_growth_yoy, STRONG_GROWTH_YOY),
    congestion: congestionScore(a).score / 100,
    load_pressure: loadFactorPressure(a.load_factor),
    volume_upside: normalize(a.annual_passengers, LARGE_AIRPORT_PAX),
  };
  const score =
    100 *
    Object.entries(EXPANSION_WEIGHTS).reduce(
      (sum, [k, w]) => sum + w * components[k as keyof typeof components],
      0,
    );
  return {
    score,
    components,
    assumptions: EXPANSION_ASSUMPTIONS,
    uncertainty:
      "Score reflects demand-side opportunity only. It does not model construction " +
      "cost, land/gate availability, or local regulatory limits (e.g. noise curfews), " +
      "which a full investment case would weigh.",
  };
}

/** Registry so tools can look up a scorer by name. */
export const METRIC_SCORERS: Record<MetricKey, (a: Airport) => ScoreResult> = {
  congestion: congestionScore,
  unmet_demand: unmetDemandScore,
  expansion: expansionScore,
};
