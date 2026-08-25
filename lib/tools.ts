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
import {
  METRIC_SCORERS,
  haulBreakdown,
  congestionScore,
  unmetDemandScore,
  expansionScore,
  roundResult,
  type MetricKey,
} from "./scoring";
import {
  ASSUMPTIONS,
  haulAssumptions,
  liveFlightsAssumptions,
  LIVE_FLIGHTS_UNCERTAINTY,
} from "./i18n";
import { flightsNearAirport } from "./liveflights";
import type { StructuredResult } from "./types";

export interface ToolOutput {
  result: Record<string, unknown>;
  structured?: StructuredResult | null;
  assumptions?: string[];
  uncertainty?: string | null;
}

const SCORE_COLUMN: Record<MetricKey, string> = {
  congestion: "Congestion score",
  unmet_demand: "Unmet-demand score",
  expansion: "Expansion score",
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (frac: number, dp = 0): string => `${(frac * 100).toFixed(dp)}%`;

function unknown(iata: string): ToolOutput {
  return { result: { error: `'${iata}' is not in the dataset.`, known_airports: data.knownIatas() } };
}

// --------------------------------------------------------------------------- //
// Tool implementations
// --------------------------------------------------------------------------- //

export function airportProfile(iata: string): ToolOutput {
  const a = data.getAirport(iata);
  if (!a) return unknown(iata);
  return {
    result: {
      iata: a.iata,
      name: a.name,
      city: a.city,
      state: a.state,
      metrics: {
        annual_passengers: a.annual_passengers,
        pax_growth_yoy: a.pax_growth_yoy,
        load_factor: a.load_factor,
        avg_dep_delay_min: a.avg_dep_delay_min,
        delayed_share: a.delayed_share,
        cancel_rate: a.cancel_rate,
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

export function rankAirports(
  scope: string = "all",
  metric: MetricKey = "expansion",
  topN = 5,
): ToolOutput {
  if (!(metric in METRIC_SCORERS)) {
    return { result: { error: `Unknown metric '${metric}'.`, valid_metrics: Object.keys(METRIC_SCORERS) } };
  }
  const airports = data.airportsInScope(scope);
  if (airports.length === 0) return { result: { error: `No airports found for scope '${scope}'.` } };

  const scorer = METRIC_SCORERS[metric];
  const ranked = airports
    .map((a) => ({ a, res: scorer(a) }))
    .sort((x, y) => y.res.score - x.res.score)
    .slice(0, Math.max(1, topN));

  const columns = ["Rank", "Airport", SCORE_COLUMN[metric], "Growth YoY", "Load factor", "Avg delay (min)"];
  const rows = ranked.map(({ a, res }, i) => [
    i + 1,
    `${a.iata} — ${a.city}`,
    round1(res.score),
    pct(a.pax_growth_yoy, 1),
    Number(a.load_factor.toFixed(2)),
    a.avg_dep_delay_min,
  ]);

  const sample = ranked[0].res;
  return {
    result: {
      metric,
      scope,
      note: "score is a 0-100 composite; the other fields are the real underlying metrics.",
      ranking: ranked.map(({ a, res }) => ({
        iata: a.iata,
        city: a.city,
        score: round1(res.score),
        pax_growth_yoy_pct: Number((a.pax_growth_yoy * 100).toFixed(1)),
        load_factor: a.load_factor,
        avg_dep_delay_min: a.avg_dep_delay_min,
        annual_passengers: a.annual_passengers,
      })),
    },
    structured: { kind: "ranking", columns, rows },
    assumptions: sample.assumptions,
    uncertainty: sample.uncertainty,
  };
}

export function compareAirports(
  iatas: string[],
  metric: MetricKey = "congestion",
): ToolOutput {
  if (!(metric in METRIC_SCORERS)) {
    return { result: { error: `Unknown metric '${metric}'.`, valid_metrics: Object.keys(METRIC_SCORERS) } };
  }
  const resolved = iatas.map((code) => ({ code, a: data.getAirport(code) }));
  const missing = resolved.filter((r) => !r.a).map((r) => r.code);
  if (missing.length > 0) {
    return { result: { error: `Unknown airport(s): ${missing.join(", ")}.`, known_airports: data.knownIatas() } };
  }

  const scorer = METRIC_SCORERS[metric];
  const scored = resolved.map((r) => ({ a: r.a as Airport, res: scorer(r.a as Airport) }));

  const columns = [
    "Airport",
    SCORE_COLUMN[metric],
    "Avg delay (min)",
    "Delayed >15m",
    "Load factor",
    "Cancel rate",
  ];
  const rows = scored.map(({ a, res }) => [
    `${a.iata} — ${a.city}`,
    round1(res.score),
    a.avg_dep_delay_min,
    pct(a.delayed_share),
    Number(a.load_factor.toFixed(2)),
    pct(a.cancel_rate, 1),
  ]);

  return {
    result: {
      metric,
      note: "score is a 0-100 composite; the other fields are the real underlying metrics.",
      comparison: scored.map(({ a, res }) => ({
        iata: a.iata,
        city: a.city,
        score: round1(res.score),
        avg_dep_delay_min: a.avg_dep_delay_min,
        pct_flights_delayed_over_15min: Math.round(a.delayed_share * 100),
        cancel_rate_pct: Number((a.cancel_rate * 100).toFixed(1)),
        load_factor: a.load_factor,
      })),
    },
    structured: { kind: "comparison", columns, rows },
    assumptions: scored[0].res.assumptions,
    uncertainty: scored[0].res.uncertainty,
  };
}

export function longHaulBreakdown(iata: string): ToolOutput {
  const a = data.getAirport(iata);
  if (!a) return unknown(iata);
  const mix = haulBreakdown(a);
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
  if (!a) return unknown(iata);
  const res = unmetDemandScore(a);
  const comp = roundResult(res).components;
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
      unmet_demand_score: round1(res.score),
      drivers: comp,
      context: {
        load_factor: a.load_factor,
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

export async function liveFlights(iata: string): Promise<ToolOutput> {
  const a = data.getAirport(iata);
  if (!a) return unknown(iata);

  try {
    const live = await flightsNearAirport(a.lat, a.lon);
    const columns = ["Live activity (now)", "Count"];
    const rows = [
      ["Airborne nearby", live.airborne],
      ["On the ground", live.onGround],
      ["Total in area", live.total],
    ];
    return {
      result: {
        iata: a.iata,
        name: a.name,
        available: true,
        airborne_nearby: live.airborne,
        on_ground: live.onGround,
        total_in_area: live.total,
        sample_callsigns: live.sample.map((f) => f.callsign),
      },
      structured: { kind: "metric", columns, rows },
      assumptions: liveFlightsAssumptions(),
      uncertainty: LIVE_FLIGHTS_UNCERTAINTY,
    };
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
  airport_profile: (a) => airportProfile(a.iata as string),
  rank_airports: (a) =>
    rankAirports(a.scope as string | undefined, (a.metric as MetricKey) ?? "expansion", (a.top_n as number) ?? 5),
  compare_airports: (a) => compareAirports((a.iatas as string[]) ?? [], (a.metric as MetricKey) ?? "congestion"),
  long_haul_breakdown: (a) => longHaulBreakdown(a.iata as string),
  unmet_demand: (a) => unmetDemand(a.iata as string),
  live_flights: (a) => liveFlights(a.iata as string),
};

/** Execute a tool by name with the LLM-supplied arguments. */
export async function runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const fn = DISPATCH[name];
  if (!fn) return { result: { error: `Unknown tool '${name}'.` } };
  try {
    return await fn(input ?? {});
  } catch (err) {
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
        scope: { type: "string", description: "'new_england', 'all', or a state code." },
        metric: { type: "string", enum: ["expansion", "congestion", "unmet_demand"] },
        top_n: { type: "integer", description: "How many to return (default 5)." },
      },
      required: ["metric"],
    },
  },
  {
    name: "compare_airports",
    description:
      "Compare two or more airports (by IATA code) on a metric. Use for 'compare X and Y " +
      "congestion'. metric='congestion', 'unmet_demand', or 'expansion'.",
    input_schema: {
      type: "object",
      properties: {
        iatas: { type: "array", items: { type: "string" }, description: "IATA codes, e.g. ['LAX','SNA']." },
        metric: { type: "string", enum: ["congestion", "unmet_demand", "expansion"] },
      },
      required: ["iatas"],
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
];
