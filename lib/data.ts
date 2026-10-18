/**
 * Data access layer over the bundled airport dataset.
 *
 * data/airports.json and data/places.json are produced by the reproducible pipeline
 * (npm run build:data:staging, then npm run promote:data) from BTS, OurAirports and U.S.
 * Census files, and every field carries its source, period and formula in the file's meta.
 * Both are imported as JSON, so they are bundled at build time and available in any runtime
 * (including Vercel functions) with no filesystem access. The much larger route table
 * (data/routes.json) is deliberately NOT imported here; see lib/routes.ts.
 *
 * This is the only module that knows how the airport data is stored, keeping the scoring
 * engine and tools independent of the storage format.
 */

import dataset from "@/data/airports.json";
import gazetteer from "@/data/places.json";
import {
  createScopeResolver,
  describeCoverage,
  type Coverage,
  type Place,
  type ScopeResolution,
} from "./geography";

export interface HaulMix {
  short: number;
  medium: number;
  long: number;
}

/**
 * One airport as the app uses it. Rates are null when the source suppressed them (too few
 * flights to be reliable); scorers then report "insufficient data" instead of a default.
 */
export interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  /** Open, non-helipad runways (OurAirports). */
  runways: number;
  /** Enplaned passengers in the data year, all carriers, domestic + international (BTS T-100). */
  annual_passengers: number;
  /** Passenger departures performed in the data year (BTS T-100). */
  annual_departures: number;
  /** Exact enplaned passengers on segments to a foreign destination (BTS T-100); the share below is this over annual_passengers, rounded. */
  international_passengers?: number;
  /** Exact passengers in the year before the data year (BTS T-100); the basis of pax_growth_yoy. Null if there was no base. */
  previous_year_passengers?: number | null;
  /** Share of annual_passengers on segments to a foreign destination. */
  international_passenger_share: number | null;
  /** Passengers vs the previous calendar year, fractional (-0.05 = 5% fewer). */
  pax_growth_yoy: number | null;
  load_factor: number | null;
  avg_dep_delay_min: number | null;
  delayed_share: number | null;
  cancel_rate: number | null;
  haul_mix: HaulMix | null;
  /** Census CBSA title containing the airport, e.g. "Boston-Cambridge-Newton, MA-NH". */
  metro?: string;
  /** Census CBSA code, e.g. "14460". */
  metro_code?: string;
}

/** The record shape in data/airports.json (pipeline output; extra fields are ignored). */
interface AirportRecord extends Omit<Airport, "metro" | "metro_code"> {
  cbsa_code: string | null;
  cbsa_name: string | null;
}

/** Provenance of one field, as written by the pipeline. */
export interface FieldProvenance {
  sources: string[];
  formula: string;
  filter?: string;
  note?: string;
}

function toAirport(record: AirportRecord): Airport {
  const { cbsa_code, cbsa_name, ...rest } = record;
  return { ...rest, metro: cbsa_name ?? undefined, metro_code: cbsa_code ?? undefined };
}

const META = dataset.meta;
const AIRPORTS: Airport[] = (dataset.airports as unknown as AirportRecord[]).map(toAirport);
const PLACES = gazetteer.places as Place[];
const BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));
const resolveScope = createScopeResolver(AIRPORTS, { places: PLACES });

/** A departure counts as delayed at 15 minutes or more late (the BTS DepDel15 definition behind every delayed-share figure). */
export const DELAY_THRESHOLD_MINUTES = 15;

/**
 * Numbers the product documents about itself (the delay threshold, how many airports, the coverage share, the data-quality
 * minimums, the haul distances, twelve months). They may be stated without a tool result, and are read from the data's
 * own metadata rather than typed in.
 */
export function documentedConstants(): number[] {
  const coverage = META.coverage as { airports: number; top_n: number; guaranteed_subset: number; national_enplanements_covered_share: number };
  const share = coverage.national_enplanements_covered_share * 100;
  const thresholds = Object.values(META.thresholds as Record<string, number>);
  return [
    DELAY_THRESHOLD_MINUTES,
    12,
    AIRPORTS.length,
    META.year,
    META.year - 1,
    coverage.top_n,
    coverage.guaranteed_subset,
    Math.round(share * 10) / 10,
    Math.round(share * 100) / 100,
    ...thresholds,
  ];
}

/** Facts about the dataset itself, generated from its meta block so a coverage answer is never from memory. */
export function datasetFacts(): string {
  const coverage = META.coverage as { airports: number; national_enplanements_covered_share: number };
  const share = Math.round(coverage.national_enplanements_covered_share * 1000) / 10;
  return (
    `The dataset covers ${AIRPORTS.length} U.S. airports (the ${coverage.airports - 2} busiest by ${META.year} passengers plus Burlington and Manchester), ` +
    `which is ${share}% of all U.S. scheduled passenger enplanements. Figures are calendar year ${META.year}, with ${META.year - 1} for comparison. ` +
    `Sources and vintage: ${META.vintage} It is a bundled snapshot rebuilt by the data pipeline when BTS publishes new data, not a live feed; live questions use separate live tools.`
  );
}

export function dataVintage(): string {
  return META.vintage;
}

/** The calendar year the traffic and delay figures describe. */
export function dataYear(): number {
  return META.year;
}

export function haulThresholds(): { short_max: number; long_min: number } {
  return META.haul_thresholds_miles;
}

/** Source, formula and filter behind a field (keys as in data/airports.json meta.fields). */
export function fieldProvenance(): Record<string, FieldProvenance> {
  return META.fields as Record<string, FieldProvenance>;
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

/** The distinct U.S. states the dataset covers (postal codes, sorted). */
export function coveredStates(): string[] {
  return [...new Set(AIRPORTS.map((a) => a.state))].sort();
}

/**
 * Resolve scope text to airports with a structured, explainable result (how it was
 * understood, notes, ambiguity options, or suggestions). The geography rules live in
 * geography.ts; this only binds them to the bundled airports and Census gazetteer.
 */
export function resolveAirportScope(scope?: string | null): ScopeResolution<Airport> {
  return resolveScope(scope);
}

/** What the bundled dataset covers (count, states, supported scope kinds). */
export function datasetCoverage(): Coverage {
  return describeCoverage(AIRPORTS);
}

/** Airports for a scope; [] unless it resolved. Use resolveAirportScope to learn why a scope failed. */
export function airportsInScope(scope?: string | null): Airport[] {
  return resolveAirportScope(scope).airports;
}
