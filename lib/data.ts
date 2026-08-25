/**
 * Data access layer over the bundled airport dataset.
 *
 * The dataset (a curated public-data snapshot) is imported directly as JSON, so it
 * is bundled at build time and available in any runtime (including Vercel functions)
 * with no filesystem access. This is the only module that knows how the data is
 * stored, keeping the scoring engine and tools independent of the storage format.
 */

import dataset from "@/data/airports.json";

export interface HaulMix {
  short: number;
  medium: number;
  long: number;
}

export interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  runways: number;
  annual_passengers: number;
  pax_growth_yoy: number;
  load_factor: number;
  avg_dep_delay_min: number;
  delayed_share: number;
  cancel_rate: number;
  annual_departures: number;
  haul_mix: HaulMix;
}

const AIRPORTS = dataset.airports as Airport[];
const META = dataset.meta;
const BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

export function dataVintage(): string {
  return META.vintage;
}

export function newEnglandStates(): string[] {
  return META.new_england_states;
}

export function haulThresholds(): { short_max: number; long_min: number } {
  return META.haul_thresholds_miles;
}

export function allAirports(): Airport[] {
  return AIRPORTS;
}

/** Look up one airport by IATA code (case-insensitive). Undefined if unknown. */
export function getAirport(iata: string): Airport | undefined {
  return BY_IATA.get(iata.trim().toUpperCase());
}

export function knownIatas(): string[] {
  return [...BY_IATA.keys()].sort();
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

// Metro areas mapped to the airports we actually have in the dataset.
const METRO_GROUPS: Record<string, string[]> = {
  la: ["LAX", "SNA"], "los angeles": ["LAX", "SNA"], "l.a.": ["LAX", "SNA"],
  socal: ["LAX", "SNA", "SAN"], "southern california": ["LAX", "SNA", "SAN"],
  "bay area": ["SFO", "OAK", "SJC"], "sf bay": ["SFO", "OAK", "SJC"],
  "san francisco bay": ["SFO", "OAK", "SJC"],
  nyc: ["JFK", "LGA", "EWR"], "new york city": ["JFK", "LGA", "EWR"],
  "new york metro": ["JFK", "LGA", "EWR"],
  dc: ["DCA", "IAD"], "washington dc": ["DCA", "IAD"], "d.c.": ["DCA", "IAD"],
};

/** The distinct U.S. states the dataset covers (for helpful "no match" messages). */
export function coveredStates(): string[] {
  return [...new Set(AIRPORTS.map((a) => a.state))].sort();
}

/**
 * Resolve a named scope to a list of airports.
 *  - "new_england" -> ME/NH/VT/MA/RI/CT
 *  - "all" | undefined -> every airport
 *  - a U.S. state, by 2-letter code ("CA") or full name ("California")
 *  - a metro area ("LA", "Bay Area", "NYC", "DC")
 * Returns [] for an unrecognized scope (callers surface a helpful message).
 * An explicit `states` list, if given, overrides `scope`.
 */
export function airportsInScope(scope?: string | null, states?: string[]): Airport[] {
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => s.trim().toUpperCase()));
    return AIRPORTS.filter((a) => wanted.has(a.state));
  }

  if (!scope || scope.trim().toLowerCase() === "all") return AIRPORTS;

  const key = scope.trim().toLowerCase();

  if (["new_england", "new-england", "newengland", "new england"].includes(key)) {
    const ne = new Set(newEnglandStates());
    return AIRPORTS.filter((a) => ne.has(a.state));
  }

  if (METRO_GROUPS[key]) {
    const codes = new Set(METRO_GROUPS[key]);
    return AIRPORTS.filter((a) => codes.has(a.iata));
  }

  const stateCode = STATE_NAME_TO_CODE[key] ?? (key.length === 2 ? key.toUpperCase() : null);
  if (stateCode) return AIRPORTS.filter((a) => a.state === stateCode);

  return [];
}
