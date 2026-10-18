/**
 * Live metro-area population and income for an airport's catchment, from the U.S.
 * Census Bureau.
 *
 * Two steps, both official:
 *   1. Census Geocoder (keyless): the airport's lat/lon -> its Metropolitan
 *      Statistical Area (CBSA) code and name. No hand-maintained airport->metro table.
 *   2. Census Data API, ACS 1-year (needs a FREE key in CENSUS_API_KEY; verified
 *      2026-10-18 that api.census.gov now redirects keyless data requests to a
 *      "Missing Key" page): total population (B01003_001E) and median household income
 *      (B19013_001E) for that CBSA, for the latest vintage and the one before it, so
 *      year-over-year population growth is computed rather than typed in.
 *
 * Without the key the tool returns a clear "not configured" result; it never guesses.
 * The key travels only in the request URL and is never logged or returned: errors from
 * the shared fetch layer carry the HTTP status only.
 */

import {
  LiveFetchError,
  TtlCache,
  fetchJson,
  lookupAirport,
  nowOf,
  retrievedAtIso,
  round,
  safeReason,
  toNumber,
  unavailable,
  type AirportRef,
  type LiveDeps,
  type LiveTool,
  type LiveToolOutput,
} from "./common";

const SOURCE = "U.S. Census Bureau (ACS 1-year via api.census.gov; metro lookup via Census Geocoder)";
const GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
const DATA_API = "https://api.census.gov/data";
const DEFAULT_ACS_YEAR = 2024; // newest 1-year vintage confirmed published on 2026-10-18
const MSA_LAYER = "Metropolitan Statistical Areas";
const MSA_FOR_CLAUSE = "metropolitan statistical area/micropolitan statistical area";

export interface Metro {
  cbsaCode: string;
  name: string;
}

interface AcsValues {
  population: number | null;
  medianHouseholdIncome: number | null;
}

const metroCache = new TtlCache<Metro | null>(7 * 24 * 60 * 60 * 1000);
const acsCache = new TtlCache<AcsValues | null>(24 * 60 * 60 * 1000);

// --------------------------------------------------------------------------- //
// Parsing
// --------------------------------------------------------------------------- //

export function parseGeocoder(body: unknown): Metro | null {
  const geographies = (body as { result?: { geographies?: Record<string, unknown> } } | null)?.result?.geographies;
  if (!geographies || typeof geographies !== "object") {
    throw new LiveFetchError("upstream returned an unexpected shape");
  }
  const msa = (geographies[MSA_LAYER] as { GEOID?: unknown; NAME?: unknown }[] | undefined)?.[0];
  const code = typeof msa?.GEOID === "string" ? msa.GEOID : null;
  const name = typeof msa?.NAME === "string" ? msa.NAME : null;
  return code && /^\d{5}$/.test(code) && name ? { cbsaCode: code, name } : null;
}

/** ACS table response: first row is the header, second row the single geography. */
export function parseAcs(body: unknown): AcsValues | null {
  if (!Array.isArray(body)) throw new LiveFetchError("upstream returned an unexpected shape");
  const [header, row] = body as unknown[][];
  if (!Array.isArray(header) || !Array.isArray(row)) return null;
  const valueOf = (variable: string): number | null => {
    const n = toNumber(row[header.indexOf(variable)]);
    return n !== null && n >= 0 ? n : null; // ACS uses large negative sentinels for "not available"
  };
  return { population: valueOf("B01003_001E"), medianHouseholdIncome: valueOf("B19013_001E") };
}

// --------------------------------------------------------------------------- //
// Fetch
// --------------------------------------------------------------------------- //

async function lookupMetro(airport: AirportRef, deps: LiveDeps): Promise<Metro | null> {
  const nowMs = nowOf(deps).getTime();
  const cached = metroCache.get(airport.iata, nowMs);
  if (cached !== undefined) return cached;

  if (!Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) throw new Error("invalid coordinates");
  const params = new URLSearchParams({
    x: airport.lon.toFixed(5),
    y: airport.lat.toFixed(5),
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    layers: MSA_LAYER,
    format: "json",
  });
  const metro = parseGeocoder(await fetchJson(`${GEOCODER}?${params.toString()}`, deps));
  metroCache.set(airport.iata, metro, nowMs);
  return metro;
}

async function fetchAcs(year: number, cbsaCode: string, apiKey: string, deps: LiveDeps): Promise<AcsValues | null> {
  const cacheKey = `${year}:${cbsaCode}`;
  const nowMs = nowOf(deps).getTime();
  const cached = acsCache.get(cacheKey, nowMs);
  if (cached !== undefined) return cached;

  if (!/^\d{5}$/.test(cbsaCode)) throw new Error("invalid cbsa");
  const params = new URLSearchParams({
    get: "NAME,B01003_001E,B19013_001E",
    for: `${MSA_FOR_CLAUSE}:${cbsaCode}`,
    key: apiKey,
  });
  // Census documents literal ',' '/' ':' and %20 (not '+') in its query strings; all are safe in a query.
  const query = params
    .toString()
    .replace(/\+/g, "%20")
    .replace(/%2C/g, ",")
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
  const values = parseAcs(await fetchJson(`${DATA_API}/${year}/acs/acs1?${query}`, deps));
  acsCache.set(cacheKey, values, nowMs);
  return values;
}

function acsYear(): number {
  const configured = Number(process.env.CENSUS_ACS_YEAR);
  return Number.isInteger(configured) && configured >= 2010 && configured <= 2100 ? configured : DEFAULT_ACS_YEAR;
}

// --------------------------------------------------------------------------- //
// Tool
// --------------------------------------------------------------------------- //

/**
 * The bundled dataset has no population field, so the generic "offer the dataset figure"
 * fallback would invite the model to make one up. Population answers must be a plain
 * "not available", with no number from memory.
 */
const NO_POPULATION_FALLBACK =
  "Say plainly that the metro population is not available right now. No population figure exists in the " +
  "bundled dataset, so do not give a number, an approximation or a figure from memory. Do not estimate.";

const populationUnavailable = (airport: { iata: string }, reason: string): LiveToolOutput =>
  unavailable(SOURCE, airport, reason, { fallback: NO_POPULATION_FALLBACK });

export async function metroPopulation(args: Record<string, unknown>, deps: LiveDeps): Promise<LiveToolOutput> {
  const found = lookupAirport(args, deps);
  if (!found.ok) return found.output;
  const { airport } = found;

  const apiKey = process.env.CENSUS_API_KEY?.trim();
  if (!apiKey) {
    return populationUnavailable(airport, "metro population is not configured: the Census Data API needs a free API key and none is set (CENSUS_API_KEY)");
  }

  try {
    const metro = await lookupMetro(airport, deps);
    if (!metro) {
      return populationUnavailable(airport, "the airport is not inside a Census metropolitan statistical area");
    }

    const year = acsYear();
    const [current, previous] = await Promise.all([
      fetchAcs(year, metro.cbsaCode, apiKey, deps),
      fetchAcs(year - 1, metro.cbsaCode, apiKey, deps).catch(() => null), // growth is optional
    ]);
    if (!current || current.population === null) {
      return populationUnavailable(airport, `no ${year} ACS 1-year population is published for ${metro.name}`);
    }

    const growth =
      previous?.population && previous.population > 0
        ? round(current.population / previous.population - 1, 4)
        : null;

    return {
      result: {
        iata: airport.iata,
        name: airport.name,
        available: true,
        metro_area: metro.name,
        cbsa_code: metro.cbsaCode,
        acs_year: year,
        population: current.population,
        population_prior_year: previous?.population ?? null,
        population_growth_yoy: growth,
        median_household_income_usd: current.medianHouseholdIncome,
        source: SOURCE,
        retrieved_at: retrievedAtIso(deps, [
          metroCache.storedAt(airport.iata, nowOf(deps).getTime()),
          acsCache.storedAt(`${year}:${metro.cbsaCode}`, nowOf(deps).getTime()),
        ]),
      },
      structured: {
        kind: "metric",
        columns: [`Census ACS ${year} (${metro.name})`, "Value"],
        rows: [
          ["Metro population", current.population],
          ["Population growth vs prior year", growth === null ? "n/a" : `${round(growth * 100, 2)}%`],
          ["Median household income (USD)", current.medianHouseholdIncome ?? "n/a"],
        ],
      },
      assumptions: [
        "The airport's catchment is approximated by the single Census metropolitan statistical area its coordinates fall in.",
        "Population and income are ACS 1-year survey estimates for that area; growth compares them to the previous year's ACS estimate.",
      ],
      uncertainty:
        "ACS figures are survey estimates with margins of error, published about nine months after the reference year. " +
        "A metro area is not the same as an airport's true catchment: multi-airport regions (e.g. New York, Bay Area) share one metro total.",
    };
  } catch (err) {
    return populationUnavailable(airport, safeReason(err));
  }
}

export const censusTool: LiveTool = {
  name: "metro_population",
  schema: {
    name: "metro_population",
    description:
      "Census Bureau population, year-over-year population growth and median household income for " +
      "the metropolitan area an airport sits in (by IATA code), queried live. Use for market-size " +
      "or catchment-demand questions about a specific airport.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'DEN'." } },
      required: ["iata"],
    },
  },
  handler: metroPopulation,
};
