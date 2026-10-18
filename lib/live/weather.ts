/**
 * Live airport weather: current METAR + latest TAF from the NOAA Aviation Weather
 * Center data API (aviationweather.gov/api/data), JSON, no key.
 *
 * The station id is the airport's ICAO code taken from the bundled airport list,
 * never from model text. METAR and TAF are fetched in parallel and fail
 * independently, so a missing TAF still returns the observation.
 */

import {
  TtlCache,
  fetchJson,
  lookupAirport,
  nowOf,
  round,
  safeReason,
  toNumber,
  unavailable,
  type LiveDeps,
  type LiveTool,
  type LiveToolOutput,
} from "./common";

const SOURCE = "NOAA Aviation Weather Center (aviationweather.gov)";
const BASE = "https://aviationweather.gov/api/data";
const MAX_TAF_CHARS = 600;

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";
const CATEGORY_RANK: FlightCategory[] = ["VFR", "MVFR", "IFR", "LIFR"];

interface CloudLayer {
  cover?: string | null;
  base?: number | null;
}

interface MetarRecord {
  obsTime?: number;
  temp?: number | null;
  dewp?: number | null;
  wdir?: number | string | null;
  wspd?: number | null;
  wgst?: number | null;
  visib?: number | string | null;
  fltCat?: string | null;
  rawOb?: string;
  clouds?: CloudLayer[];
}

interface TafPeriod {
  visib?: number | string | null;
  clouds?: CloudLayer[];
  wxString?: string | null;
}

interface TafRecord {
  issueTime?: string;
  validTimeFrom?: number;
  validTimeTo?: number;
  rawTAF?: string;
  fcsts?: TafPeriod[];
}

const metarCache = new TtlCache<MetarRecord | null>(120_000);
const tafCache = new TtlCache<TafRecord | null>(300_000);

// --------------------------------------------------------------------------- //
// Pure helpers
// --------------------------------------------------------------------------- //

/** Visibility arrives as a number or a string like "10+" / "6+" (statute miles). */
function visibilityMiles(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Ceiling = lowest broken/overcast/vertical-visibility layer base (ft AGL), else null. */
export function ceilingFeet(clouds: CloudLayer[] | undefined): number | null {
  const bases = (clouds ?? [])
    .filter((c) => ["BKN", "OVC", "OVX"].includes(String(c.cover)) && typeof c.base === "number")
    .map((c) => c.base as number);
  return bases.length ? Math.min(...bases) : null;
}

/** Standard FAA flight categories from ceiling (ft) and visibility (sm). */
export function flightCategory(ceiling: number | null, visibility: number | null): FlightCategory | null {
  if (ceiling === null && visibility === null) return null;
  const c = ceiling ?? Infinity;
  const v = visibility ?? Infinity;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}

function worstCategory(periods: TafPeriod[]): FlightCategory | null {
  let worst = -1;
  for (const p of periods) {
    const cat = flightCategory(ceilingFeet(p.clouds), visibilityMiles(p.visib));
    if (cat) worst = Math.max(worst, CATEGORY_RANK.indexOf(cat));
  }
  return worst < 0 ? null : CATEGORY_RANK[worst];
}

function summarizeMetar(m: MetarRecord) {
  const ceiling = ceilingFeet(m.clouds);
  const visibility = visibilityMiles(m.visib);
  return {
    observed_utc: m.obsTime ? new Date(m.obsTime * 1000).toISOString() : null,
    flight_category:
      m.fltCat && CATEGORY_RANK.includes(m.fltCat as FlightCategory) ? m.fltCat : flightCategory(ceiling, visibility),
    wind_direction_deg: toNumber(m.wdir),
    wind_speed_kt: toNumber(m.wspd),
    wind_gust_kt: toNumber(m.wgst),
    visibility_sm: visibility,
    ceiling_ft: ceiling,
    temperature_c: toNumber(m.temp) === null ? null : round(Number(m.temp)),
    dewpoint_c: toNumber(m.dewp) === null ? null : round(Number(m.dewp)),
    raw: typeof m.rawOb === "string" ? m.rawOb.slice(0, 300) : null,
  };
}

function summarizeTaf(t: TafRecord) {
  const periods = t.fcsts ?? [];
  const phenomena = [...new Set(periods.map((p) => p.wxString).filter((w): w is string => !!w))].slice(0, 6);
  return {
    issued_utc: t.issueTime ?? null,
    valid_from_utc: t.validTimeFrom ? new Date(t.validTimeFrom * 1000).toISOString() : null,
    valid_to_utc: t.validTimeTo ? new Date(t.validTimeTo * 1000).toISOString() : null,
    forecast_periods: periods.length,
    worst_flight_category_in_forecast: worstCategory(periods),
    weather_phenomena: phenomena,
    raw: typeof t.rawTAF === "string" ? t.rawTAF.slice(0, MAX_TAF_CHARS) : null,
  };
}

// --------------------------------------------------------------------------- //
// Fetch
// --------------------------------------------------------------------------- //

async function fetchFirstRecord<T>(
  kind: "metar" | "taf",
  icao: string,
  cache: TtlCache<T | null>,
  deps: LiveDeps,
): Promise<T | null> {
  const nowMs = nowOf(deps).getTime();
  const cacheKey = `${kind}:${icao}`;
  const cached = cache.get(cacheKey, nowMs);
  if (cached !== undefined) return cached;

  // icao comes from the bundled airport list; the shape check is defence in depth.
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error("invalid station id");
  const url = `${BASE}/${kind}?${new URLSearchParams({ ids: icao, format: "json" }).toString()}`;
  const body = await fetchJson(url, deps);
  if (body !== null && !Array.isArray(body)) throw new Error("unexpected response format");
  const record = ((body as T[] | null)?.[0] ?? null) as T | null;
  cache.set(cacheKey, record, nowMs);
  return record;
}

// --------------------------------------------------------------------------- //
// Tool
// --------------------------------------------------------------------------- //

export async function airportWeather(args: Record<string, unknown>, deps: LiveDeps): Promise<LiveToolOutput> {
  const found = lookupAirport(args, deps);
  if (!found.ok) return found.output;
  const { airport } = found;
  const icao = airport.icao.toUpperCase();

  const [metarRes, tafRes] = await Promise.allSettled([
    fetchFirstRecord<MetarRecord>("metar", icao, metarCache, deps),
    fetchFirstRecord<TafRecord>("taf", icao, tafCache, deps),
  ]);

  if (metarRes.status === "rejected" && tafRes.status === "rejected") {
    return unavailable(SOURCE, airport, safeReason(metarRes.reason));
  }

  const metar = metarRes.status === "fulfilled" && metarRes.value ? summarizeMetar(metarRes.value) : null;
  const taf = tafRes.status === "fulfilled" && tafRes.value ? summarizeTaf(tafRes.value) : null;
  if (!metar && !taf) {
    return unavailable(SOURCE, airport, `no current METAR or TAF is published for station ${icao}`);
  }

  const issues: string[] = [];
  if (!metar) issues.push("no current observation (METAR) available");
  if (!taf) issues.push("no forecast (TAF) available; many smaller airports do not issue one");

  const rows: (string | number)[][] = [];
  if (metar) {
    rows.push(["Flight category now", metar.flight_category ?? "n/a"]);
    rows.push(["Wind (kt)", metar.wind_speed_kt ?? "n/a"]);
    rows.push(["Visibility (sm)", metar.visibility_sm ?? "n/a"]);
    rows.push(["Ceiling (ft)", metar.ceiling_ft ?? "none"]);
  }
  if (taf) rows.push(["Worst category in TAF", taf.worst_flight_category_in_forecast ?? "n/a"]);

  return {
    result: {
      iata: airport.iata,
      name: airport.name,
      station: icao,
      available: true,
      metar,
      taf,
      ...(issues.length ? { gaps: issues } : {}),
      source: SOURCE,
      retrieved_at: nowOf(deps).toISOString(),
    },
    structured: { kind: "metric", columns: ["Weather (now)", "Value"], rows },
    assumptions: [
      "Live METAR (latest observation) and TAF (forecast) for the airport's own weather station, from NOAA's Aviation Weather Center at the moment you asked.",
      "Flight category follows the standard FAA ceiling/visibility thresholds (VFR, MVFR, IFR, LIFR).",
    ],
    uncertainty:
      "A single observation is a snapshot, not climatology: it says nothing about typical weather delay risk. " +
      "The TAF is a forecast and is revised throughout the day.",
  };
}

export const weatherTool: LiveTool = {
  name: "airport_weather",
  schema: {
    name: "airport_weather",
    description:
      "Live weather at one airport by IATA code: current METAR (wind, visibility, ceiling, flight " +
      "category) and the latest TAF forecast summary. Use ONLY for current or near-term weather " +
      "questions, not historical or seasonal weather.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'SEA'." } },
      required: ["iata"],
    },
  },
  handler: airportWeather,
};
