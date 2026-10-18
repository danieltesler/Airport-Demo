/**
 * The code-owned text: assumptions, uncertainty caveats, and panel labels. These
 * come from the code (not the LLM) so they stay consistent and trustworthy. The app
 * is English-only.
 */

import type { ResolvedAs } from "./geography";

/** One sentence on how every input is scaled; the rule itself lives in lib/anchors.ts. */
const ANCHOR_RULE =
  "Each input is scaled 0-1 between anchors set by one rule: the 5th and 95th percentile of " +
  "that input across the dataset's airports, rounded to two significant figures.";

/** The thin-data rule applied by the data pipeline before anything is scored. */
const SUPPRESSION_RULE =
  "Rates are never defaulted: an airport with under 5,000 scheduled departures in the BTS " +
  "On-Time data, or under 365 departures in T-100, has that rate suppressed and the score " +
  "is shown as insufficient data.";

export const ASSUMPTIONS = {
  congestion: [
    "Congestion is proxied by operational strain: average departure delay, the share of " +
      "departures 15 minutes or more late, and the cancellation rate (BTS On-Time " +
      "Reporting Carrier data, calendar year 2025). Seat load factor is scored separately " +
      "in the unmet-demand and expansion scores.",
    "Metrics are compared as rates (per flight), not totals, so large hubs and small " +
      "airports are judged on the same footing. " + ANCHOR_RULE,
  ],
  unmet: [
    "'Unmet demand' has no direct public measurement (bookings that never happened " +
      "aren't observable in free data). We estimate it as a composite lower-bound proxy.",
    "Load factor (passengers / seats on departing scheduled flights, BTS T-100 2025, all " +
      "carriers) is the primary signal: sustained high seat utilization implies demand " +
      "that current supply cannot absorb.",
    "Passenger growth (2025 vs 2024) measured against how hard the runways are already " +
      "worked indicates a widening gap; a declining airport scores below a flat one.",
  ],
  expansion: [
    "Investment thesis (demand-side): the case for terminal expansion is strongest " +
      "where strong, growing demand meets a capacity-constrained airport — so renovation " +
      "unlocks revenue rather than adding idle space.",
    "Score blends passenger growth (2025 vs 2024), current congestion, seat load pressure, " +
      "and passenger volume (every enplaned passenger, domestic and international, all " +
      "carriers); weights are documented and adjustable. " + ANCHOR_RULE,
    "Airport scope is limited to the bundled dataset: the 100 busiest U.S. airports by 2025 " +
      "passengers, plus Burlington (BTV) and Manchester (MHT).",
  ],
};

export const UNCERTAINTY = {
  congestion:
    "Delays are 2025 averages for the large reporting carriers (and their regional partners) " +
    "on domestic flights. Short-term peaks are smoothed out, weather is mixed with true " +
    "capacity saturation, and a smaller airport's delays often originate at the hubs its " +
    "flights go to. " + SUPPRESSION_RULE,
  unmet:
    "This is a lower-bound proxy. True unmet demand (searches that didn't convert, " +
    "fares that priced people out) requires proprietary GDS/OAG data not available for free. " +
    SUPPRESSION_RULE,
  expansion:
    "Score reflects demand-side opportunity only. It does not model construction cost, " +
    "land/gate availability, or local regulatory limits (e.g. noise curfews), which a " +
    "full investment case would weigh. Growth is a single year (2025 vs 2024).",
};

/** Why a score was not computed for an airport (named null inputs, never a default). */
export function insufficientDataReason(metric: keyof typeof METRIC_LABELS, missing: string[]): string {
  const verb = missing.length === 1 ? "is" : "are";
  return (
    `Insufficient data: ${METRIC_LABELS[metric].toLowerCase()} score not computed because ` +
    `${missing.join(", ")} ${verb} suppressed in the source data for this airport (too few flights for a reliable rate).`
  );
}

/** Dataset-scope assumption (dynamic airport count). */
export function scopeAssumption(count: number): string {
  return `Dataset scope is limited to ${count} U.S. airports.`;
}

function airportCount(count: number): string {
  return `${count} ${count === 1 ? "airport" : "airports"}`;
}

/** How each kind of scope is named in a caption; null adds nothing (the label says it). */
export const SCOPE_KIND_TEXT: Record<ResolvedAs, string | null> = {
  all: null,
  airport: "airport",
  metro: "metro area",
  state: "state",
  census_division: "Census division",
  census_region: "Census region",
  informal_region: "informal region",
  radius: "by distance",
};

/**
 * Table caption stating exactly what a ranking covers and how the scope was resolved,
 * e.g. "Scope: New England · Census division · 6 airports matched · top 3 by ...".
 * The label comes first and alone so lib/spoken.ts can read it up to the first " · ".
 */
export function rankingCaption(p: {
  label: string;
  resolvedAs: ResolvedAs;
  /** Set when the user's wording was simplified; shown so the caption is not read as an exact match. */
  readFrom?: string;
  /** For an informal region, its member states ("CA, OR, WA"), shown after the kind. */
  detail?: string;
  matched: number;
  /** Matched airports left out because a required input is suppressed. */
  unscored?: number;
  shown: number;
  scoreLabel: string;
  /** `asc` ranks the lowest score first; the caption says so. */
  order?: "asc" | "desc";
}): string {
  const kind = SCOPE_KIND_TEXT[p.resolvedAs];
  const parts = [
    `Scope: ${p.label}`,
    ...(kind ? [p.detail ? `${kind} (${p.detail})` : kind] : []),
    ...(p.readFrom ? [`read from "${p.readFrom}"`] : []),
    `${airportCount(p.matched)} matched`,
    ...(p.unscored ? [`${p.unscored} not scored (insufficient data)`] : []),
    `top ${p.shown} by ${p.scoreLabel.toLowerCase()}${p.order === "asc" ? ", lowest first" : ""}`,
  ];
  return parts.join(" · ");
}

/**
 * Table caption for a side-by-side comparison. `reading` says how the airports were chosen,
 * e.g. ": LAX, SNA" or " in San Francisco Bay Area (metro area)".
 */
export function comparisonCaption(count: number, scoreLabel: string, reading = ""): string {
  return `Comparing ${airportCount(count)}${reading} · ${scoreLabel.toLowerCase()}`;
}

export const METRIC_LABELS = {
  congestion: "Congestion",
  unmet_demand: "Unmet demand",
  expansion: "Expansion",
};

/** Plain-language names for scoring components, keyed by the keys used in scoring.ts. */
export const COMPONENT_LABELS: Record<string, string> = {
  delayed_share: "Flights delayed 15 min or more",
  avg_delay: "Average departure delay",
  cancellations: "Cancellation rate",
  load_pressure: "Load-factor pressure",
  congestion: "Congestion (a 0-100 score itself)",
  growth_vs_capacity: "Growth vs. runway capacity",
  demand_growth: "Passenger growth",
  volume_upside: "Passenger volume",
};

/** Haul-mix assumptions (dynamic distance thresholds). */
export function haulAssumptions(t: { short_max: number; long_min: number }): string[] {
  return [
    `Haul class is by great-circle route distance from T-100 segment data: short ` +
      `<${t.short_max} mi, medium ${t.short_max}-${t.long_min} mi, long >${t.long_min} mi.`,
    "Percentages are shares of scheduled passenger departures performed in 2025 (all " +
      "carriers, international segments included), not passengers or seats.",
  ];
}

/** Assumptions and caveat for the live flights tool. */
export function liveFlightsAssumptions(): string[] {
  return [
    "Live positions come from a community ADS-B feed (adsb.lol), for aircraft within " +
      "about 30 nautical miles of the airport at the moment you asked.",
    "Coverage depends on nearby receivers, so the count is a lower bound on real " +
      "traffic; aircraft on the ground are counted separately.",
  ];
}

export const LIVE_FLIGHTS_UNCERTAINTY =
  "This is a real-time snapshot, not a schedule — the numbers change minute to " +
  "minute, and low-altitude or non-ADS-B aircraft may be missed.";

/** UI labels for the assumptions & uncertainty panel. */
export const PANEL_LABELS = {
  title: "Assumptions & uncertainty",
  assumptions: "Assumptions",
  uncertainty: "Uncertainty",
  dataVintage: "Data vintage",
  tools: "Tools",
  explainSummary: "How was this scored?",
};

// --------------------------------------------------------------------------- //
// Route tools (BTS T-100 segments by origin, destination and carrier)
// --------------------------------------------------------------------------- //

/** What the route figures are, stated with every route table. */
export function routeAssumptions(p: { years: string; coveredAirports: number }): string[] {
  return [
    `Route figures are BTS T-100 Segment records for scheduled passenger service (${p.years}): each row is one ` +
      "carrier's flights between two airports. Passengers are enplaned passengers per segment, so a connecting " +
      "trip counts once on each segment and a route's figure is not the number of people travelling between two cities.",
    "Seats and departures are those performed on the segment, and distance is great-circle miles.",
    `Only the ${p.coveredAirports} airports in the dataset are origins; a destination can be any airport. ` +
      "2025 is the latest complete year, and 2024 is the comparison year.",
  ];
}

/** Added when a table names regional airlines, which BTS reports as the operating carrier. */
export const OPERATING_CARRIER_ASSUMPTION =
  "BTS reports the operating carrier. Regional airlines such as SkyWest, Republic, Envoy and Endeavor fly under " +
  "other airlines' brands, so the name on the ticket may differ; carriers marked 'operating carrier' are such airlines.";

/** Caveat for every route result: facts about segments versus inferences about service. */
export const ROUTE_UNCERTAINTY =
  "'No nonstop service in this data' is a fact about T-100 segments from the 102 covered airports; it does not " +
  "show a market is 'underserved', which is an inference this data cannot support on its own (it ignores " +
  "connecting itineraries, fares, nearby airports and seasonal or charter service).";

/** Extra caveat for year-over-year comparisons. */
export const TREND_UNCERTAINTY =
  "The trend compares two calendar years: it shows which carriers and routes changed, not why " +
  "(schedule, fleet, demand or strategy are not in the data).";

/** Caveat when a result is a cap on a longer list. */
export function cappedNote(shown: number, total: number, noun: string): string {
  return `Showing ${shown} of ${total} ${noun}.`;
}

export function routeSearchCaption(p: {
  origin: string;
  year: number;
  destination: string | null;
  shown: number;
  total: number;
  sortLabel: string;
  carrier?: string | null;
}): string {
  const to = p.destination ? ` to ${p.destination}` : "";
  const only = p.carrier ? ` · only ${p.carrier}` : "";
  return `Routes from ${p.origin}${to}${only} · ${p.year} · top ${p.shown} of ${p.total} by ${p.sortLabel}`;
}

export function carrierShareCaption(p: {
  origin: string;
  year: number;
  destination: string | null;
  shown: number;
  total: number;
}): string {
  const to = p.destination ? ` to ${p.destination}` : "";
  const bucket = p.total > p.shown ? ` · ${p.total - p.shown} others grouped` : "";
  return `Carrier share, flights from ${p.origin}${to} · ${p.year} · top ${p.shown} of ${p.total} carriers${bucket}`;
}

export function capacityTrendCaption(p: {
  origin: string;
  destination: string | null;
  priorYear: number;
  year: number;
  groupBy: string;
  carrier?: string | null;
}): string {
  const to = p.destination ? ` to ${p.destination}` : "";
  return `Capacity trend, ${p.carrier ?? "all airlines"} flights from ${p.origin}${to} · ${p.priorYear} to ${p.year} · biggest changes by ${p.groupBy}`;
}

// --------------------------------------------------------------------------- //
// Live-data labels (caption and footer; built by code from the tool's own retrieval time)
// --------------------------------------------------------------------------- //

/** Short source names for captions, keyed by live tool name. */
export const LIVE_SOURCE_NAMES: Record<string, string> = {
  faa_airport_status: "FAA NAS Status",
  airport_weather: "NOAA Aviation Weather Center",
  bts_airport_traffic: "BTS T-100 (data.bts.gov)",
  faa_airport_infrastructure: "FAA airport record (USDOT NTAD)",
  metro_population: "U.S. Census Bureau",
  live_flights: "adsb.lol community ADS-B feed",
};

const utcTime = (iso: string): string => `${iso.slice(11, 16)} UTC`;
const utcDateTime = (iso: string): string => `${iso.slice(0, 10)} ${utcTime(iso)}`;

/** Table caption for a live result, e.g. "Source: FAA NAS Status · retrieved 14:32 UTC". */
export function liveCaption(source: string, retrievedAtIso: string): string {
  return `Source: ${source} · retrieved ${utcTime(retrievedAtIso)}`;
}

/**
 * The data-vintage footer. A dataset-only turn keeps the dataset vintage; a live-only turn
 * names each live source and its retrieval time; a mixed turn shows both, labelled.
 */
export function vintageFooter(p: {
  datasetVintage: string;
  usedDataset: boolean;
  usedLive: boolean;
  live: { source: string; retrievedAt: string }[];
}): string | undefined {
  const live = p.live.map((l) => `${l.source} · retrieved ${utcDateTime(l.retrievedAt)}`);
  const liveText = live.length > 0 ? `Live data: ${live.join("; ")}` : undefined;
  if (!p.usedLive) return p.datasetVintage;
  if (!p.usedDataset) return liveText;
  return liveText ? `Dataset: ${p.datasetVintage} | ${liveText}` : p.datasetVintage;
}
