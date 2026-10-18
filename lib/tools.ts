/**
 * Agent tools: the bridge between the LLM and the deterministic engine.
 *
 * Each tool pulls data (data.ts) and runs scoring (scoring.ts). The LLM may only
 * obtain numbers by calling these tools — it never invents figures. Every tool
 * returns a `ToolOutput` carrying:
 *   - result       compact JSON the LLM reads to write its answer
 *   - structured   optional table/chart payload for the UI (per the API contract)
 *   - assumptions  the deterministic assumptions behind the numbers
 *   - uncertainty  honest caveats to surface to the user
 *
 * `TOOL_SCHEMAS` is the provider-neutral tool-definition list; `runTool` dispatches by name.
 */

import * as data from "./data";
import type { Airport } from "./data";
import { SCOPE_DESCRIPTION, USER_WORDS_DESCRIPTION, capPlaceText, resolveToolScope, scopeProblem, unknownAirport } from "./toolScope";
import { ROUTE_TOOLS, routeToolSchemas } from "./routeTools";
import { RouteDataError } from "./routes";

import {
  METRIC_SCORERS,
  haulBreakdown,
  congestionScore,
  unmetDemandScore,
  expansionScore,
  isScored,
  roundResult,
  type MetricKey,
  type ScoreOutcome,
  type ScoreResult,
} from "./scoring";
import {
  ASSUMPTIONS,
  haulAssumptions,
  rankingCaption,
  comparisonCaption,
  SCOPE_KIND_TEXT,
  liveFlightsAssumptions,
  LIVE_FLIGHTS_UNCERTAINTY,
  LIVE_SOURCE_NAMES,
  liveCaption,
} from "./i18n";
import { asksForCalendarYear } from "./calendarYear";
import { collapseSpelledLetters } from "./spelledCodes";
import { requestedCount, requestedOrder } from "./requestedCount";
import { clean as cleanComparisonWords, namedAirports } from "./namedAirports";
import { roundTo } from "./rounding";
import { percentText, percentValue } from "./percent";
import { explainScores } from "./explain";
import { flightsNearAirport } from "./liveflights";
import { isLiveTool, liveToolSchemas, runLiveTool } from "./live";
import type { StructuredResult } from "./types";

export { resolveToolScope };

export interface ToolOutput {
  result: Record<string, unknown>;
  structured?: StructuredResult | null;
  assumptions?: string[];
  uncertainty?: string | null;
  /** Set for a successful live-data call: its source and retrieval time (code-owned, never sent to the model). */
  live?: { source: string; retrievedAt: string };
}

const SCORE_COLUMN: Record<MetricKey, string> = {
  congestion: "Congestion score",
  unmet_demand: "Unmet-demand score",
  expansion: "Expansion score",
};

const airportLabel = (a: Airport): string => `${a.iata} — ${a.city}`;

/** Table text for a suppressed (null) source value. Never a number, so it cannot be misread as one. */
const NOT_AVAILABLE = "n/a";
const INSUFFICIENT_DATA = "insufficient data";

const pct = (frac: number | null, dp = 0): string => (frac === null ? NOT_AVAILABLE : `${(frac * 100).toFixed(dp)}%`);
/** Load factor as a one-decimal percentage, the same text everywhere it is tabulated. */
const loadFactorCell = (ratio: number | null): string => percentText(ratio) ?? NOT_AVAILABLE;
const orNotAvailable = (value: number | null): number | string => (value === null ? NOT_AVAILABLE : value);
const pctNumber = (frac: number | null, dp: number): number | null =>
  frac === null ? null : Number((frac * 100).toFixed(dp));

interface ScoredAirport {
  a: Airport;
  res: ScoreResult;
}

/** Split airports into scored and "insufficient data", each unscored one with its missing inputs. */
function scoreAirports(airports: Airport[], metric: MetricKey): { scored: ScoredAirport[]; unscored: { iata: string; missing: string[] }[] } {
  const scorer = METRIC_SCORERS[metric];
  const scored: ScoredAirport[] = [];
  const unscored: { iata: string; missing: string[] }[] = [];
  for (const a of airports) {
    const res: ScoreOutcome = scorer(a);
    if (isScored(res)) scored.push({ a, res });
    else unscored.push({ iata: a.iata, missing: res.missing });
  }
  return { scored, unscored };
}

// --------------------------------------------------------------------------- //
// Tool implementations
// --------------------------------------------------------------------------- //

/** Enplaned international passengers: the exact stored count, else passengers times the (rounded) share. */
function internationalPassengers(a: Airport): number | null {
  if (typeof a.international_passengers === "number") return a.international_passengers; // exact count from the data
  return a.international_passenger_share === null ? null : Math.round(a.annual_passengers * a.international_passenger_share);
}

const growthDirection = (growth: number | null): string | null =>
  growth === null ? null : growth > 0 ? "up" : growth < 0 ? "down" : "flat";

const fmtInt = (n: number): string => n.toLocaleString("en-US");

/** One plain sentence with the headline figures and their period, to be quoted exactly. */
function profileSummary(a: Airport): string {
  const year = data.dataYear();
  const parts = [`${fmtInt(a.annual_passengers)} enplaned passengers`];
  const international = internationalPassengers(a);
  if (international !== null) parts.push(`${fmtInt(international)} of them international (${percentValue(a.international_passenger_share)}%)`);
  const growth = percentValue(a.pax_growth_yoy);
  if (growth !== null) {
    const prior = typeof a.previous_year_passengers === "number" ? ` (${fmtInt(a.previous_year_passengers)} in ${year - 1})` : "";
    parts.push(`passengers ${growthDirection(a.pax_growth_yoy)} ${Math.abs(growth)}% from ${year - 1}${prior}`);
  }
  if (a.avg_dep_delay_min !== null) parts.push(`average departure delay ${a.avg_dep_delay_min} minutes`);
  const late = percentValue(a.delayed_share);
  if (late !== null) parts.push(`${late}% of departures 15 minutes or more late`);
  const cancelled = percentValue(a.cancel_rate);
  if (cancelled !== null) parts.push(`cancellation rate ${cancelled}%`);
  return `${a.iata}, calendar year ${year}: ${parts.join("; ")}.`;
}

export function airportProfile(iata: string): ToolOutput {
  const a = data.getAirport(iata);
  if (!a) return unknownAirport(iata);
  return {
    result: {
      iata: a.iata,
      name: a.name,
      city: a.city,
      state: a.state,
      metro_area: a.metro ?? null,
      data_year: data.dataYear(),
      period: `calendar year ${data.dataYear()} (BTS T-100 and On-Time data); growth compares ${data.dataYear()} with ${data.dataYear() - 1}. Not a live or trailing-12-month figure.`,
      note: "A null metric was suppressed in the source data (too few flights); say so, never guess it. Quote these figures exactly; never answer an airport figure from memory.",
      facts_summary: profileSummary(a),
      metrics: {
        annual_passengers: a.annual_passengers,
        passengers_prior_year: a.previous_year_passengers ?? null,
        international_passengers: internationalPassengers(a),
        international_passenger_share: a.international_passenger_share,
        international_passenger_share_pct: percentValue(a.international_passenger_share),
        pax_growth_yoy: a.pax_growth_yoy,
        pax_growth_pct: percentValue(a.pax_growth_yoy),
        pax_growth_direction: growthDirection(a.pax_growth_yoy),
        load_factor: a.load_factor,
        load_factor_pct: percentValue(a.load_factor),
        avg_dep_delay_min: a.avg_dep_delay_min,
        delayed_share: a.delayed_share,
        delayed_share_pct: percentValue(a.delayed_share),
        cancel_rate: a.cancel_rate,
        cancel_rate_pct: percentValue(a.cancel_rate),
        annual_departures: a.annual_departures,
        runways: a.runways,
      },
      haul_mix_pct: haulBreakdown(a),
      scores: {
        congestion: roundResult(congestionScore(a)),
        unmet_demand: roundResult(unmetDemandScore(a)),
        expansion: roundResult(expansionScore(a)),
      },
    },
    assumptions: [ASSUMPTIONS.expansion[0]],
  };
}

/** Facts about how many airports were returned versus asked for, so wording cannot overclaim. */
function countFacts(requested: number, returned: number, matched: number): Record<string, unknown> {
  const facts: Record<string, unknown> = { requested_top_n: requested, airports_returned: returned };
  if (matched < requested) {
    facts.count_note =
      `Only ${matched} ${matched === 1 ? "airport" : "airports"} in the dataset matched, fewer than the ` +
      `${requested} asked for. Say so plainly; do not say "top ${requested}".`;
    facts.dataset_states = data.coveredStates();
  }
  return facts;
}

/** What rank 1 means for each metric and direction, so a ranking cannot be described backwards. */
const RANK_FIRST_MEANS: Record<MetricKey, Record<"asc" | "desc", string>> = {
  congestion: {
    desc: "Rank 1 is the MOST congested airport (highest congestion score).",
    asc: "Rank 1 is the LEAST congested airport (lowest congestion score); the list runs from least to more congested.",
  },
  unmet_demand: {
    desc: "Rank 1 has the HIGHEST estimated unmet demand.",
    asc: "Rank 1 has the LOWEST estimated unmet demand; the list runs from lowest upward.",
  },
  expansion: {
    desc: "Rank 1 has the STRONGEST demand-side case for expansion.",
    asc: "Rank 1 has the WEAKEST demand-side case for expansion; the list runs from weakest upward.",
  },
};

/** Most airports one ranking returns. */
const MAX_RANKED = 25;

/** A usable top-N: a whole number from 1 to MAX_RANKED; anything else (NaN, text, 0) becomes the default. */
function rankLimit(raw: unknown, fallback = 5): number {
  const n = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_RANKED) : fallback;
}

export function rankAirports(
  scope: string = "all",
  metric: MetricKey = "expansion",
  topN = 5,
  userWords?: string,
  options: { userMessage?: string; order?: "asc" | "desc" } = {},
): ToolOutput {
  if (!(metric in METRIC_SCORERS)) {
    return { result: { error: `Unknown metric '${metric}'.`, valid_metrics: Object.keys(METRIC_SCORERS) } };
  }
  // The user's own words win over the model's arguments for "top 3" and for "least congested".
  const askedCount = requestedCount(options.userMessage);
  const order = requestedOrder(options.userMessage) ?? (options.order === "asc" ? "asc" : "desc");
  topN = askedCount !== null ? Math.min(askedCount, MAX_RANKED) : rankLimit(topN);
  const resolution = resolveToolScope(scope, userWords);
  if (resolution.status !== "matched") return scopeProblem(resolution);
  const airports = resolution.airports;

  const { scored, unscored } = scoreAirports(airports, metric);
  if (scored.length === 0) {
    return {
      result: {
        error: `No airport in ${resolution.label} has enough data for the ${metric} score.`,
        insufficient_data: unscored,
        scope_label: resolution.label,
      },
    };
  }
  const ranked = scored
    .sort((x, y) => (order === "asc" ? x.res.score - y.res.score : y.res.score - x.res.score))
    .slice(0, Math.max(1, topN));

  const columns = ["Rank", "Airport", SCORE_COLUMN[metric], "Growth YoY", "Load factor", "Avg delay (min)"];
  const rows = ranked.map(({ a, res }, i) => [
    i + 1,
    airportLabel(a),
    roundTo(res.score),
    pct(a.pax_growth_yoy, 1),
    loadFactorCell(a.load_factor),
    orNotAvailable(a.avg_dep_delay_min),
  ]);

  const sample = ranked[0].res;
  return {
    result: {
      metric,
      order,
      ranked_first_means: RANK_FIRST_MEANS[metric][order],
      scope,
      scope_resolved_as: resolution.resolvedAs,
      scope_label: resolution.label,
      airports_matched: airports.length,
      ...countFacts(Math.max(1, topN), ranked.length, scored.length),
      ...(unscored.length > 0
        ? {
            insufficient_data: unscored,
            insufficient_data_note:
              `${unscored.length} matched ${unscored.length === 1 ? "airport has" : "airports have"} a suppressed input ` +
              `and ${unscored.length === 1 ? "is" : "are"} not ranked. Name them as 'insufficient data'; never estimate their score.`,
          }
        : {}),
      scope_notes: resolution.notes,
      note: "score is a 0-100 composite; the other fields are the real underlying metrics.",
      ranking: ranked.map(({ a, res }) => ({
        iata: a.iata,
        city: a.city,
        score: roundTo(res.score),
        pax_growth_yoy_pct: pctNumber(a.pax_growth_yoy, 1),
        load_factor: a.load_factor,
        load_factor_pct: percentValue(a.load_factor),
        avg_dep_delay_min: a.avg_dep_delay_min,
        annual_passengers: a.annual_passengers,
      })),
    },
    structured: {
      kind: "ranking",
      columns,
      rows,
      caption: rankingCaption({
        label: resolution.label,
        resolvedAs: resolution.resolvedAs!,
        readFrom: resolution.reinterpreted ? resolution.input : undefined,
        detail: resolution.detail,
        matched: airports.length,
        unscored: unscored.length,
        shown: ranked.length,
        scoreLabel: SCORE_COLUMN[metric],
        order,
      }),
      explain: explainScores(ranked.map(({ a }) => a), metric, airportLabel),
    },
    assumptions: sample.assumptions,
    uncertainty: sample.uncertainty,
  };
}

/** Most airports one comparison table will hold when comparing a whole scope. */
const MAX_COMPARED_FROM_SCOPE = 8;

/** The area a comparison covers, and how it was read, for the caption and the model. */
interface AreaChoice {
  iatas: string[];
  note: string;
  reading: string;
}

/** Airport codes for "compare everything in <scope>": the busiest airports, capped. */
function iatasFromScope(scope: string, userWords: string | undefined): { choice?: AreaChoice; problem?: ToolOutput } {
  let resolution = resolveToolScope(scope, userWords);
  if (resolution.status === "unknown") {
    // The model may pass the whole request ("compare the New York airports"); retry on the place alone.
    const placeScope = cleanComparisonWords(scope);
    const placeWords = cleanComparisonWords(userWords ?? "");
    if (placeScope || placeWords) {
      const retried = resolveToolScope(placeScope, placeWords);
      if (retried.status !== "unknown") resolution = retried;
    }
  }
  if (resolution.status !== "matched") return { problem: scopeProblem(resolution) };
  const busiest = [...resolution.airports].sort((a, b) => b.annual_passengers - a.annual_passengers);
  const chosen = busiest.slice(0, MAX_COMPARED_FROM_SCOPE).map((a) => a.iata);
  const capped = busiest.length > chosen.length;
  const kind = resolution.resolvedAs ? SCOPE_KIND_TEXT[resolution.resolvedAs] : null;
  const note = capped
    ? `${busiest.length} airports matched ${resolution.label}; the ${chosen.length} busiest by passengers are compared.`
    : `Compared all ${busiest.length} airports matched in ${resolution.label}.`;
  const reading = ` in ${resolution.label}${kind ? ` (${kind}${resolution.detail ? `: ${resolution.detail}` : ""})` : ""}${capped ? `, the busiest of ${busiest.length}` : ""}`;
  return { choice: { iatas: chosen, note, reading } };
}

/**
 * When a city NAME picked the airports ("Washington" is DCA, not Dulles), say which airports of the
 * same metro area were not compared, so a missing airport is stated rather than silently dropped.
 */
function sameMetroNote(viaCity: boolean, picked: Airport[]): string {
  if (!viaCity) return "";
  const pickedCodes = new Set(picked.map((a) => a.iata));
  const metros = new Set(picked.map((a) => a.metro_code).filter(Boolean));
  const others = data
    .allAirports()
    .filter((a) => a.metro_code && metros.has(a.metro_code) && !pickedCodes.has(a.iata))
    .map((a) => a.iata);
  return others.length > 0 ? ` Matched by city name; other airports in the same metro area were not compared: ${others.join(", ")}.` : "";
}

/** A part of the request such as "New York" that matches several airports: ask, never expand silently. */
function ambiguousAirportName(part: string, candidates: Airport[]): ToolOutput {
  return {
    result: {
      error: `'${part}' matches more than one airport (${candidates.map((c) => c.iata).join(", ")}). Ask the user which airports to compare, or call again with the airport codes in iatas.`,
      status: "ambiguous",
      options: candidates.map((c) => ({ label: airportLabel(c), scope: c.iata })),
      coverage: data.datasetCoverage(),
    },
  };
}

export function compareAirports(
  iatas: string[],
  metric: MetricKey = "congestion",
  scope?: string,
  userWords?: string,
  options: { userMessage?: string } = {},
): ToolOutput {
  if (!(metric in METRIC_SCORERS)) {
    return { result: { error: `Unknown metric '${metric}'.`, valid_metrics: Object.keys(METRIC_SCORERS) } };
  }
  // Bound what the model can make us scan: place text to 200 characters, airport codes to 20.
  scope = capPlaceText(scope);
  userWords = capPlaceText(userWords);
  iatas = (Array.isArray(iatas) ? iatas.slice(0, 20) : []).map((code) => (typeof code === "string" ? collapseSpelledLetters(code) : code));
  let scopeNote: string | undefined;
  let reading = "";

  // The user's own words are the authority on WHICH airports: when they name specific airports
  // ("Portland Oregon and Seattle", "LAX and Santa Ana") those are compared even if the model passed
  // different codes or an improvised scope, and a city with several airports ("Dallas") is asked
  // about even if the model already picked one. The model's arguments cannot override this.
  // The user's actual message is read first: a model that rewrote the place ("Dallas-Fort Worth and Austin")
  // cannot hide that the user said "Dallas". A follow-up that picked one ("DFW please") arrives as a
  // rewritten message that names it.
  const fromMessage = namedAirports(options.userMessage);
  const userNamed = fromMessage?.kind === "airports" || fromMessage?.kind === "ambiguous" ? fromMessage : namedAirports(userWords);
  if (userNamed?.kind === "ambiguous") return ambiguousAirportName(userNamed.part, userNamed.candidates);
  if (userNamed?.kind === "airports") {
    const namedCodes = userNamed.airports.map((a) => a.iata);
    const passed = iatas.map((code) => String(code).toUpperCase());
    const disagrees = passed.length > 0 && (passed.length !== namedCodes.length || passed.some((code) => !namedCodes.includes(code)));
    const passedText = passed.length > 0 ? passed.join(", ") : scope?.trim() ? `the scope '${scope.trim()}'` : "";
    iatas = namedCodes;
    scope = undefined;
    scopeNote =
      `Compared exactly the airports named: ${namedCodes.join(", ")}.${sameMetroNote(userNamed.viaCity, userNamed.airports)}` +
      (disagrees || (passed.length === 0 && passedText) ? ` The user's words were used instead of ${passedText}.` : "");
  }
  if (scopeNote === undefined && iatas.length === 0 && (scope?.trim() || userWords?.trim())) {
    // Specific airports named in the words ("LAX and SNA") are compared exactly; only an area is expanded.
    const named = namedAirports(userWords) ?? namedAirports(scope);
    if (named?.kind === "ambiguous") return ambiguousAirportName(named.part, named.candidates);
    if (named) {
      iatas = named.airports.map((a) => a.iata);
      scopeNote = `Compared exactly the airports named: ${iatas.join(", ")}.${sameMetroNote(named.viaCity, named.airports)}`;
    } else {
      const fromScope = iatasFromScope(scope ?? "", userWords);
      if (fromScope.problem) return fromScope.problem;
      iatas = fromScope.choice!.iatas;
      scopeNote = fromScope.choice!.note;
      reading = fromScope.choice!.reading;
    }
  }
  const resolved = iatas.map((code) => ({ code, a: data.getAirport(code) }));
  const missing = resolved.filter((r) => !r.a).map((r) => r.code);
  if (missing.length > 0) {
    return { result: { error: `Unknown airport(s): ${missing.join(", ")}.`, known_airports: data.knownIatas() } };
  }

  const scorer = METRIC_SCORERS[metric];
  // The same airport named twice (e.g. "LAX, lax") is compared once.
  const unique = resolved.filter((r, i) => resolved.findIndex((o) => o.a!.iata === r.a!.iata) === i);
  if (unique.length === 0) {
    return { result: { error: "Name at least one airport (iatas) or an area (scope / user_words) to compare.", known_airports: data.knownIatas() } };
  }
  const scored = unique.map((r) => ({ a: r.a as Airport, res: scorer(r.a as Airport) }));
  // Highest score first; airports with insufficient data go last.
  scored.sort((x, y) => Number(isScored(y.res)) - Number(isScored(x.res)) || (isScored(x.res) && isScored(y.res) ? y.res.score - x.res.score : 0));
  if (!reading) reading = `: ${scored.map(({ a }) => a.iata).sort().join(", ")}`;

  const columns = [
    "Airport",
    SCORE_COLUMN[metric],
    "Avg delay (min)",
    "Delayed 15+ min",
    "Load factor",
    "Cancel rate",
  ];
  const rows = scored.map(({ a, res }) => [
    airportLabel(a),
    isScored(res) ? roundTo(res.score) : INSUFFICIENT_DATA,
    orNotAvailable(a.avg_dep_delay_min),
    pct(a.delayed_share),
    loadFactorCell(a.load_factor),
    pct(a.cancel_rate, 1),
  ]);
  const sample = scored.find(({ res }) => isScored(res))?.res ?? scored[0].res;

  return {
    result: {
      metric,
      ...(scopeNote ? { scope_note: scopeNote } : {}),
      note: "score is a 0-100 composite; the other fields are the real underlying metrics. A null score is insufficient data, not zero.",
      comparison: scored.map(({ a, res }) => ({
        iata: a.iata,
        city: a.city,
        score: isScored(res) ? roundTo(res.score) : null,
        ...(isScored(res) ? {} : { insufficient_data: res.reason }),
        avg_dep_delay_min: a.avg_dep_delay_min,
        pct_flights_delayed_15min_or_more: pctNumber(a.delayed_share, 0),
        cancel_rate_pct: pctNumber(a.cancel_rate, 1),
        load_factor: a.load_factor,
        load_factor_pct: percentValue(a.load_factor),
      })),
    },
    structured: {
      kind: "comparison",
      columns,
      rows,
      caption: comparisonCaption(scored.length, SCORE_COLUMN[metric], reading),
      explain: explainScores(scored.map(({ a }) => a), metric, airportLabel),
    },
    assumptions: sample.assumptions,
    uncertainty: sample.uncertainty,
  };
}

/** A single-airport answer that cannot be given because the source suppressed the input. */
function insufficientData(a: Airport, reason: string, uncertainty?: string | null): ToolOutput {
  return {
    result: { iata: a.iata, name: a.name, insufficient_data: reason, instruction: "Say the data is insufficient; never estimate it." },
    uncertainty: uncertainty ?? null,
  };
}

export function longHaulBreakdown(iata: string): ToolOutput {
  const a = data.getAirport(iata);
  if (!a) return unknownAirport(iata);
  const mix = haulBreakdown(a);
  if (!mix) {
    return insufficientData(a, "Insufficient data: the haul mix is suppressed in the source data for this airport (too few departures).");
  }
  const t = data.haulThresholds();
  const columns = ["Haul type", "Share of departures"];
  const rows = [
    [`Short (<${t.short_max} mi)`, `${mix.short}%`],
    [`Medium (${t.short_max}-${t.long_min} mi)`, `${mix.medium}%`],
    [`Long (>${t.long_min} mi)`, `${mix.long}%`],
  ];
  return {
    result: { iata: a.iata, name: a.name, haul_mix_pct: mix, thresholds_miles: t },
    structured: { kind: "breakdown", columns, rows },
    assumptions: haulAssumptions(t),
  };
}

export function unmetDemand(iata: string): ToolOutput {
  const a = data.getAirport(iata);
  if (!a) return unknownAirport(iata);
  const res = unmetDemandScore(a);
  if (!isScored(res)) return insufficientData(a, res.reason, res.uncertainty);
  const comp = (roundResult(res) as ScoreResult).components;
  const columns = ["Driver", "Contribution (0-1)"];
  const rows = [
    ["Load-factor pressure", comp.load_pressure],
    ["Congestion (delay/throughput)", comp.congestion],
    ["Growth vs. capacity", comp.growth_vs_capacity],
  ];
  return {
    result: {
      iata: a.iata,
      name: a.name,
      unmet_demand_score: roundTo(res.score),
      drivers: comp,
      context: {
        load_factor: a.load_factor,
        load_factor_pct: percentValue(a.load_factor),
        pax_growth_yoy: a.pax_growth_yoy,
        runways: a.runways,
        avg_dep_delay_min: a.avg_dep_delay_min,
      },
    },
    structured: { kind: "metric", columns, rows },
    assumptions: res.assumptions,
    uncertainty: res.uncertainty,
  };
}

/** True for any tool that reads a live feed, whose answer carries a source and retrieval time instead of the dataset vintage. */
export const isLiveSourceTool = (name: string): boolean => isLiveTool(name) || name === "live_flights";

/**
 * Give a successful live result its code-owned caption and `live` source record. The retrieval
 * time is the tool's own timestamp. A failed call (available=false) has no table and no source line.
 */
function withLiveSource(toolName: string, output: ToolOutput): ToolOutput {
  const { available, retrieved_at: retrievedAt } = output.result;
  if (available === false || typeof retrievedAt !== "string") return output;
  const source = LIVE_SOURCE_NAMES[toolName] ?? toolName;
  return {
    ...output,
    structured: output.structured ? { ...output.structured, caption: liveCaption(source, retrievedAt) } : output.structured,
    live: { source, retrievedAt },
  };
}

export async function liveFlights(iata: string): Promise<ToolOutput> {
  const a = data.getAirport(iata);
  if (!a) return unknownAirport(iata);

  try {
    const live = await flightsNearAirport(a.lat, a.lon);
    const columns = ["Live activity (now)", "Count"];
    const rows = [
      ["Airborne nearby", live.airborne],
      ["On the ground", live.onGround],
      ["Total in area", live.total],
    ];
    return withLiveSource("live_flights", {
      result: {
        iata: a.iata,
        name: a.name,
        available: true,
        retrieved_at: new Date().toISOString(),
        airborne_nearby: live.airborne,
        on_ground: live.onGround,
        total_in_area: live.total,
        sample_callsigns: live.sample.map((f) => f.callsign),
      },
      structured: { kind: "metric", columns, rows },
      assumptions: liveFlightsAssumptions(),
      uncertainty: LIVE_FLIGHTS_UNCERTAINTY,
    });
  } catch (err) {
    return {
      result: {
        iata: a.iata,
        available: false,
        message: `Couldn't reach the live flight feed: ${(err as Error).message}`,
      },
    };
  }
}

// --------------------------------------------------------------------------- //
// Dispatch + schemas
// --------------------------------------------------------------------------- //

type ToolFn = (args: Record<string, unknown>) => ToolOutput | Promise<ToolOutput>;

const DISPATCH: Record<string, ToolFn> = {
  ...ROUTE_TOOLS,
  airport_profile: (a) => airportProfile(a.iata as string),
  rank_airports: (a) =>
    rankAirports(
      a.scope as string | undefined,
      (a.metric as MetricKey) ?? "expansion",
      (a.top_n as number) ?? 5,
      a.user_words as string | undefined,
      { userMessage: a.user_message as string | undefined, order: a.order as "asc" | "desc" | undefined },
    ),
  compare_airports: (a) => compareAirports(
      (a.iatas as string[]) ?? [],
      (a.metric as MetricKey) ?? "congestion",
      a.scope as string | undefined,
      a.user_words as string | undefined,
      { userMessage: a.user_message as string | undefined },
    ),
  long_haul_breakdown: (a) => longHaulBreakdown(a.iata as string),
  unmet_demand: (a) => unmetDemand(a.iata as string),
  live_flights: (a) => liveFlights(a.iata as string),
};

/** Execute a tool by name with the LLM-supplied arguments. */
export async function runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  // A calendar-year question ("Atlanta in 2025 vs 2024", "last year") is answered from the dataset's calendar-year
  // figures. The live BTS summary covers a trailing 12 months, and a model that used it labelled it as a year.
  if (name === "bts_airport_traffic" && asksForCalendarYear(input?.user_message as string | undefined)) {
    const profile = airportProfile(String(input.iata ?? ""));
    if (profile.result.error) return profile;
    return {
      ...profile,
      result: {
        ...profile.result,
        substituted_for: "bts_airport_traffic",
        substitution_note:
          "The question is about a calendar year (2025, 2024 or last year), so these are the dataset's calendar-year figures. The live BTS summary is a trailing 12 months and does not line up with a calendar year.",
      },
    };
  }
  // Live public-API tools (lib/live) validate their own input and never throw.
  if (isLiveTool(name)) return withLiveSource(name, await runLiveTool(name, input ?? {}));
  const fn = Object.hasOwn(DISPATCH, name) ? DISPATCH[name] : undefined;
  if (!fn) return { result: { error: `Unknown tool '${name}'.` } };
  try {
    return await fn(input ?? {});
  } catch (err) {
    if (err instanceof RouteDataError) {
      return { result: { error: "The route data could not be loaded right now. No route figures are available; try again shortly." } };
    }
    return { result: { error: `Bad arguments for '${name}': ${(err as Error).message}` } };
  }
}

/** Provider-neutral tool definition (mapped to the LLM SDK's format in agent.ts). */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "airport_profile",
    description:
      "Full metric profile for one airport by IATA code (e.g. 'SFO'): traffic, delays, " +
      "load factor, haul mix, and all deterministic scores.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'BOS'." } },
      required: ["iata"],
    },
  },
  {
    name: "rank_airports",
    description:
      "Rank airports within a scope by a deterministic metric. Use for questions like " +
      "'best candidates for terminal expansion'. metric='expansion' for expansion " +
      "candidates, 'congestion', or 'unmet_demand'.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: SCOPE_DESCRIPTION },
        user_words: { type: "string", description: USER_WORDS_DESCRIPTION },
        metric: { type: "string", enum: ["expansion", "congestion", "unmet_demand"] },
        order: {
          type: "string",
          enum: ["desc", "asc"],
          description: "desc (default): highest score first. asc: lowest first, for 'least congested', 'lowest', 'fewest'.",
        },
        top_n: { type: "integer", description: "How many to return (default 5, at most 25). Use the number the user asked for." },
      },
      required: ["metric"],
    },
  },
  {
    name: "compare_airports",
    description:
      "Compare airports on a metric. Pass IATA codes in 'iatas' for 'compare X and Y', OR " +
      "pass 'scope' (and leave 'iatas' out) to compare the airports in a named area, e.g. " +
      "'compare airports in <area>'; code picks the airports (up to " + MAX_COMPARED_FROM_SCOPE +
      ", busiest first). Do not ask the user for codes when they named an area. " +
      "metric='congestion', 'unmet_demand', or 'expansion'.",
    input_schema: {
      type: "object",
      properties: {
        iatas: { type: "array", items: { type: "string" }, description: "IATA codes, e.g. ['LAX','SNA']." },
        scope: { type: "string", description: SCOPE_DESCRIPTION },
        user_words: { type: "string", description: USER_WORDS_DESCRIPTION },
        metric: { type: "string", enum: ["congestion", "unmet_demand", "expansion"] },
      },
      required: [],
    },
  },
  {
    name: "long_haul_breakdown",
    description:
      "Short/medium/long-haul share of departures for one airport by IATA code. Use for " +
      "'percentage of long-haul flights out of X'.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string" } },
      required: ["iata"],
    },
  },
  {
    name: "unmet_demand",
    description:
      "Estimate unmet flight demand for one airport by IATA code, with the drivers behind " +
      "it. Use for 'unmet demand at X and why'.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string" } },
      required: ["iata"],
    },
  },
  {
    name: "live_flights",
    description:
      "Real-time count of aircraft in the air right now near an airport (by IATA code), " +
      "from live ADS-B data. Use ONLY for questions about current / live / right-now " +
      "flight activity — not for historical traffic, rankings, or scores.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string" } },
      required: ["iata"],
    },
  },
  // Route-level tools over the BTS T-100 route table (lib/routeTools.ts).
  ...routeToolSchemas(),
  // Live public-API tools: current conditions and official statistics queried at question time.
  ...liveToolSchemas(),
];
