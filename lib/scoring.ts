/**
 * Deterministic scoring engine for airport investment analysis.
 *
 * This module is the analytical core of the agent. It has **no LLM calls and no
 * I/O** — just pure functions over airport metric objects. That separation is
 * deliberate: the numbers an analyst sees must be reproducible and auditable,
 * independent of any language-model output.
 *
 * Design choices (see docs/DESIGN.md for the full rationale):
 *  - Every input is scaled to 0-1 between two **anchors** produced by one rule (lib/anchors.ts):
 *    the 5th and 95th percentile of that input across the bundled airports, rounded outward to
 *    two significant figures. The anchors are frozen here as constants, so a score means the same
 *    thing whichever scope is asked about; a test re-derives them from the data.
 *  - Scaling is two-sided, so a declining airport scores below a flat one.
 *  - Composite scores are simple **transparent weighted sums** on a 0-100 scale.
 *    Weights live in one place and are easy to defend.
 *  - A missing (suppressed) input is never defaulted: the score is reported as
 *    insufficient data, naming the missing inputs.
 *  - Each scorer returns not just a number but its **components** and the
 *    **assumptions** behind it, so the agent can explain itself and stay honest.
 */

import type { Airport } from "./data";
import { scaleToAnchor, type Anchor } from "./anchors";
import { roundTo } from "./rounding";
import { ASSUMPTIONS, UNCERTAINTY, insufficientDataReason } from "./i18n";

// --------------------------------------------------------------------------- //
// Anchors — the raw values that scale to 0 and 1. Produced by the rule in
// lib/anchors.ts from the 2025 data; lib/anchors.test.ts fails if they drift.
// --------------------------------------------------------------------------- //

export type AnchorKey =
  | "avg_dep_delay_min"
  | "delayed_share"
  | "cancel_rate"
  | "load_factor"
  | "pax_growth_yoy"
  | "annual_passengers"
  | "departures_per_runway";

export const ANCHORS: Record<AnchorKey, Anchor> = {
  avg_dep_delay_min: { low: 10, high: 22 }, // minutes, average departure delay
  delayed_share: { low: 0.14, high: 0.26 }, // share of departures 15 min or more late (BTS DepDel15)
  cancel_rate: { low: 0.0051, high: 0.026 }, // share of scheduled departures cancelled
  load_factor: { low: 0.73, high: 0.83 }, // passengers / seats on departing segments
  pax_growth_yoy: { low: -0.084, high: 0.066 }, // passengers vs the previous calendar year
  annual_passengers: { low: 1_200_000, high: 31_000_000 }, // enplaned, all carriers, incl. international
  departures_per_runway: { low: 4_800, high: 69_000 }, // passenger departures per open runway
};

/** The raw value each anchor applies to; null when the input is suppressed. */
export const ANCHOR_INPUTS: Record<AnchorKey, (a: Airport) => number | null> = {
  avg_dep_delay_min: (a) => a.avg_dep_delay_min,
  delayed_share: (a) => a.delayed_share,
  cancel_rate: (a) => a.cancel_rate,
  load_factor: (a) => a.load_factor,
  pax_growth_yoy: (a) => a.pax_growth_yoy,
  annual_passengers: (a) => a.annual_passengers,
  departures_per_runway: (a) => a.annual_departures / Math.max(a.runways, 1),
};

export function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

/** Scale one anchored input of an airport to 0-1. Callers check for null inputs first. */
function scaled(a: Airport, key: AnchorKey): number {
  return scaleToAnchor(ANCHOR_INPUTS[key](a) as number, ANCHORS[key]);
}

/** Seat-supply pressure on 0-1: 0 at or below the low anchor, 1 at or above the high one. */
export function loadFactorPressure(loadFactor: number): number {
  return scaleToAnchor(loadFactor, ANCHORS.load_factor);
}

export type MetricKey = "congestion" | "unmet_demand" | "expansion";

/** A score plus the components and assumptions that produced it. */
export interface ScoreResult {
  score: number; // 0-100
  components: Record<string, number>; // named 0-1 contributions
  assumptions: string[];
  uncertainty: string | null;
}

/** A score that could not be computed because a required input is suppressed (null). */
export interface InsufficientData {
  score: null;
  /** Names of the null input fields. */
  missing: string[];
  reason: string;
  assumptions: string[];
  uncertainty: string | null;
}

export type ScoreOutcome = ScoreResult | InsufficientData;

export function isScored(outcome: ScoreOutcome): outcome is ScoreResult {
  return outcome.score !== null;
}

/** Input fields each score needs. A null in any of them means "insufficient data". */
export const REQUIRED_INPUTS: Record<MetricKey, (keyof Airport)[]> = {
  congestion: ["avg_dep_delay_min", "delayed_share", "cancel_rate"],
  unmet_demand: ["avg_dep_delay_min", "delayed_share", "cancel_rate", "load_factor", "pax_growth_yoy"],
  expansion: ["avg_dep_delay_min", "delayed_share", "cancel_rate", "load_factor", "pax_growth_yoy"],
};

function missingInputs(a: Airport, metric: MetricKey): string[] {
  return REQUIRED_INPUTS[metric].filter((field) => a[field] === null || a[field] === undefined).map(String);
}

function insufficient(metric: MetricKey, missing: string[], assumptions: string[], uncertainty: string): InsufficientData {
  return { score: null, missing, reason: insufficientDataReason(metric, missing), assumptions, uncertainty };
}

const round = roundTo;

/** Round an outcome for transport. */
export function roundResult(result: ScoreOutcome): ScoreOutcome {
  if (!isScored(result)) return result;
  const components: Record<string, number> = {};
  for (const [k, v] of Object.entries(result.components)) components[k] = round(v, 3);
  return { ...result, score: round(result.score, 1), components };
}

function weightedSum(weights: Record<string, number>, components: Record<string, number>): number {
  return 100 * Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * components[key], 0);
}

// --------------------------------------------------------------------------- //
// Congestion
// --------------------------------------------------------------------------- //

// Load factor is deliberately absent: unmet demand and expansion already weight it
// directly, so keeping it here would count it a second time through this score.
export const CONGESTION_WEIGHTS: Record<string, number> = {
  delayed_share: 0.4375,
  avg_delay: 0.375,
  cancellations: 0.1875,
};

/** The three scaled congestion inputs. Inputs must be non-null (the callers check). */
function congestionComponents(a: Airport): Record<string, number> {
  return {
    delayed_share: scaled(a, "delayed_share"),
    avg_delay: scaled(a, "avg_dep_delay_min"),
    cancellations: scaled(a, "cancel_rate"),
  };
}

/** Congestion as a 0-1 level, for the scores that build on it; same arithmetic as congestionScore / 100. */
const congestionLevel = (a: Airport): number => weightedSum(CONGESTION_WEIGHTS, congestionComponents(a)) / 100;

export function congestionScore(a: Airport): ScoreOutcome {
  const missing = missingInputs(a, "congestion");
  if (missing.length > 0) return insufficient("congestion", missing, ASSUMPTIONS.congestion, UNCERTAINTY.congestion);
  const components = congestionComponents(a);
  return {
    score: weightedSum(CONGESTION_WEIGHTS, components),
    components,
    assumptions: ASSUMPTIONS.congestion,
    uncertainty: UNCERTAINTY.congestion,
  };
}

// --------------------------------------------------------------------------- //
// Long-haul mix
// --------------------------------------------------------------------------- //

/** Haul mix as percentages; null when the source suppressed it (too few departures). */
export function haulBreakdown(a: Airport): { short: number; medium: number; long: number } | null {
  if (!a.haul_mix) return null;
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

/** 0-1: passenger growth relative to how hard the runways are already worked. Inputs must be non-null. */
export function growthVsCapacity(a: Airport): number {
  // A weighted blend of the two signals — demand growth (weighted more) and runway
  // throughput. Higher on either raises the gap estimate; decline lowers it.
  return clamp(0.6 * scaled(a, "pax_growth_yoy") + 0.4 * scaled(a, "departures_per_runway"));
}

export function unmetDemandScore(a: Airport): ScoreOutcome {
  const missing = missingInputs(a, "unmet_demand");
  if (missing.length > 0) return insufficient("unmet_demand", missing, ASSUMPTIONS.unmet, UNCERTAINTY.unmet);
  const components = {
    load_pressure: scaled(a, "load_factor"),
    congestion: congestionLevel(a),
    growth_vs_capacity: growthVsCapacity(a),
  };
  return {
    score: weightedSum(UNMET_DEMAND_WEIGHTS, components),
    components,
    assumptions: ASSUMPTIONS.unmet,
    uncertainty: UNCERTAINTY.unmet,
  };
}

// --------------------------------------------------------------------------- //
// Expansion attractiveness — the headline demand-side opportunity score
// --------------------------------------------------------------------------- //

export const EXPANSION_WEIGHTS: Record<string, number> = {
  demand_growth: 0.3, // future demand to justify the build
  congestion: 0.3, // today's strain that expansion would relieve
  load_pressure: 0.25, // seats already scarce
  volume_upside: 0.15, // scale of passengers who benefit
};

export function expansionScore(a: Airport): ScoreOutcome {
  const missing = missingInputs(a, "expansion");
  if (missing.length > 0) return insufficient("expansion", missing, ASSUMPTIONS.expansion, UNCERTAINTY.expansion);
  const components = {
    demand_growth: scaled(a, "pax_growth_yoy"),
    congestion: congestionLevel(a),
    load_pressure: scaled(a, "load_factor"),
    volume_upside: scaled(a, "annual_passengers"),
  };
  return {
    score: weightedSum(EXPANSION_WEIGHTS, components),
    components,
    assumptions: ASSUMPTIONS.expansion,
    uncertainty: UNCERTAINTY.expansion,
  };
}

/** Registry so tools can look up a scorer by name. */
export type Scorer = (a: Airport) => ScoreOutcome;

export const METRIC_SCORERS: Record<MetricKey, Scorer> = {
  congestion: congestionScore,
  unmet_demand: unmetDemandScore,
  expansion: expansionScore,
};

/** Weights per metric, exported so explanations read the same numbers the scorers use. */
export const METRIC_WEIGHTS: Record<MetricKey, Record<string, number>> = {
  congestion: CONGESTION_WEIGHTS,
  unmet_demand: UNMET_DEMAND_WEIGHTS,
  expansion: EXPANSION_WEIGHTS,
};
