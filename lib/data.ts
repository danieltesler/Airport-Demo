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

/**
 * Resolve a named scope to a list of airports.
 *  - "new_england" -> ME/NH/VT/MA/RI/CT
 *  - "all" | undefined -> every airport
 *  - a 2-letter state code (e.g. "CA") -> that state
 * An explicit `states` list, if given, overrides `scope`.
 */
export function airportsInScope(scope?: string | null, states?: string[]): Airport[] {
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => s.trim().toUpperCase()));
    return AIRPORTS.filter((a) => wanted.has(a.state));
  }

  if (!scope || scope.toLowerCase() === "all") return AIRPORTS;

  const key = scope.trim().toLowerCase();
  if (["new_england", "new-england", "newengland"].includes(key)) {
    const ne = new Set(newEnglandStates());
    return AIRPORTS.filter((a) => ne.has(a.state));
  }

  return AIRPORTS.filter((a) => a.state === scope.trim().toUpperCase());
}
