/**
 * Live per-airport traffic from BTS T-100, queried with a filter at question time.
 *
 * Source: data.bts.gov Socrata dataset r495-tyji, "AFF - T100 Segment Summary By
 * Origin Airport" (U.S. DOT / Bureau of Transportation Statistics, US-gov-works
 * licence, no key). One row per origin airport per month, so a single small SoQL
 * query (last 24 months for one airport) yields trailing-12-month passengers,
 * departures, seats, load factor and year-over-year growth, computed here from the
 * raw monthly rows rather than typed in.
 *
 * "Passengers" are T-100 segment passengers ENPLANED at the origin airport (i.e.
 * departing passengers, domestic + international). The data is published with a
 * lag of several months, so the tool always reports which months it covers.
 */

import {
  TtlCache,
  fetchJson,
  lookupAirport,
  nowOf,
  retrievedAtIso,
  round,
  safeReason,
  toNumber,
  unavailable,
  LiveFetchError,
  type LiveDeps,
  type LiveTool,
  type LiveToolOutput,
} from "./common";
import { percentText, percentValue } from "../percent";

const SOURCE = "U.S. DOT BTS T-100 Segment Summary by Origin Airport (data.bts.gov, dataset r495-tyji)";
const ENDPOINT = "https://data.bts.gov/resource/r495-tyji.json";
const MONTHS_NEEDED = 24;

export interface MonthRow {
  month: string; // YYYY-MM
  passengers: number;
  departures: number;
  seats: number;
  domesticPassengers: number;
}

export interface TrailingWindow {
  from: string;
  to: string;
  passengers: number;
  domesticPassengers: number;
  departures: number;
  seats: number;
  loadFactor: number | null;
}

const cache = new TtlCache<MonthRow[]>(6 * 60 * 60 * 1000); // monthly dataset: 6 h is plenty

// --------------------------------------------------------------------------- //
// Pure helpers
// --------------------------------------------------------------------------- //

/** Parse raw Socrata rows into one row per month (duplicates dropped), newest first. */
export function parseMonthRows(body: unknown): MonthRow[] {
  if (!Array.isArray(body)) throw new LiveFetchError("upstream returned an unexpected shape");
  const byMonth = new Map<string, MonthRow>();
  for (const raw of body as Record<string, unknown>[]) {
    const month = typeof raw.reporting_month === "string" ? raw.reporting_month.slice(0, 7) : null;
    const passengers = toNumber(raw.total_passengers);
    const departures = toNumber(raw.total_departures);
    const seats = toNumber(raw.total_seats);
    if (!month || !/^\d{4}-\d{2}$/.test(month) || passengers === null || departures === null || seats === null) {
      continue;
    }
    // One row per month: a repeated month is a duplicate of the same figures, so the first is kept
    // rather than summed (summing would double that month's traffic).
    if (byMonth.has(month)) continue;
    byMonth.set(month, {
      month,
      passengers,
      departures,
      seats,
      domesticPassengers: toNumber(raw.domestic_passengers) ?? 0,
    });
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** True when the rows are `count` consecutive months (no gaps), newest first. */
export function isContiguous(rows: MonthRow[]): boolean {
  return rows.every((r, i) => i === 0 || monthIndex(rows[i - 1].month) - monthIndex(r.month) === 1);
}

export function sumWindow(rows: MonthRow[]): TrailingWindow {
  const total = rows.reduce(
    (acc, r) => ({
      passengers: acc.passengers + r.passengers,
      domesticPassengers: acc.domesticPassengers + r.domesticPassengers,
      departures: acc.departures + r.departures,
      seats: acc.seats + r.seats,
    }),
    { passengers: 0, domesticPassengers: 0, departures: 0, seats: 0 },
  );
  return {
    from: rows[rows.length - 1].month,
    to: rows[0].month,
    ...total,
    loadFactor: total.seats > 0 ? round(total.passengers / total.seats, 3) : null,
  };
}

export interface TrafficSummary {
  latestMonth: string;
  trailing12: TrailingWindow;
  prior12: TrailingWindow | null;
  passengerGrowthYoy: number | null;
}

/** Trailing 12 months, plus the 12 before them when 24 contiguous months exist. */
export function summarizeTraffic(rows: MonthRow[]): TrafficSummary | null {
  if (rows.length < 12) return null;
  const recent = rows.slice(0, 12);
  if (!isContiguous(recent)) return null;
  const trailing12 = sumWindow(recent);

  const prior = rows.slice(12, 24);
  const hasPrior = prior.length === 12 && isContiguous(rows.slice(0, 24));
  const prior12 = hasPrior ? sumWindow(prior) : null;
  const growth =
    prior12 && prior12.passengers > 0 ? round(trailing12.passengers / prior12.passengers - 1, 4) : null;
  return { latestMonth: rows[0].month, trailing12, prior12, passengerGrowthYoy: growth };
}

const MATERIAL_DIFFERENCE = 0.05;

/**
 * When the bundled dataset also has a passenger figure for this airport, say how the two
 * relate so the model can explain a difference by period instead of looking contradictory.
 * Both are enplaned passengers, domestic + international, so the live TOTAL is compared
 * (the dataset counts scheduled service only; this summary also has non-scheduled segments,
 * usually a few percent). Scores keep using the dataset; this is context only.
 */
export function bundledDatasetNote(
  datasetPassengers: number | undefined,
  livePassengers: number,
  summary: TrafficSummary,
  datasetVintage: string | undefined,
): { bundled_dataset?: Record<string, unknown> } {
  if (!datasetPassengers || datasetPassengers <= 0) return {};
  const relativeDifference = round(livePassengers / datasetPassengers - 1, 3);
  const material = Math.abs(relativeDifference) >= MATERIAL_DIFFERENCE;
  return {
    bundled_dataset: {
      annual_passengers: datasetPassengers,
      dataset_vintage: datasetVintage ?? "not stated",
      live_vs_dataset: relativeDifference,
      differs_materially: material,
      explanation: material
        ? `The live figure covers ${summary.trailing12.from} to ${summary.trailing12.to}; the dataset snapshot covers a different period (see its vintage) and counts scheduled service only. ` +
          "Present both with their own periods and say the difference reflects timing. Scores are computed from the dataset, not this live figure."
        : "Live and dataset figures are within 5%. Scores are computed from the dataset, not this live figure.",
    },
  };
}

// --------------------------------------------------------------------------- //
// Fetch
// --------------------------------------------------------------------------- //

async function fetchMonthRows(iata: string, deps: LiveDeps): Promise<MonthRow[]> {
  const nowMs = nowOf(deps).getTime();
  const cached = cache.get(iata, nowMs);
  if (cached) return cached;

  // iata is validated /^[A-Z]{3}$/ upstream, so it cannot break out of the SoQL literal.
  const query = new URLSearchParams({
    $select: "reporting_month,total_passengers,total_departures,total_seats,domestic_passengers",
    $where: `origin_airport_code='${iata}'`,
    $order: "reporting_month DESC",
    $limit: String(MONTHS_NEEDED + 4), // small slack in case of duplicate-month rows
  });
  const rows = parseMonthRows(await fetchJson(`${ENDPOINT}?${query.toString()}`, deps));
  cache.set(iata, rows, nowMs);
  return rows;
}

// --------------------------------------------------------------------------- //
// Tool
// --------------------------------------------------------------------------- //

export async function btsAirportTraffic(args: Record<string, unknown>, deps: LiveDeps): Promise<LiveToolOutput> {
  const found = lookupAirport(args, deps);
  if (!found.ok) return found.output;
  const { airport } = found;

  let rows: MonthRow[];
  try {
    rows = await fetchMonthRows(airport.iata, deps);
  } catch (err) {
    return unavailable(SOURCE, airport, safeReason(err));
  }

  const summary = summarizeTraffic(rows);
  if (!summary) {
    return unavailable(
      SOURCE,
      airport,
      rows.length === 0
        ? `no T-100 rows exist for ${airport.iata}`
        : "fewer than 12 consecutive months of T-100 data are available for this airport",
    );
  }

  const { trailing12: t12, prior12, passengerGrowthYoy } = summary;
  const rowsOut: (string | number)[][] = [
    [`Enplaned passengers (${t12.from} to ${t12.to})`, t12.passengers],
    ["Departures", t12.departures],
    ["Seats", t12.seats],
    ["Load factor", percentText(t12.loadFactor) ?? "n/a"],
    ["Passenger growth vs prior 12 months", passengerGrowthYoy === null ? "n/a" : `${round(passengerGrowthYoy * 100)}%`],
  ];

  return {
    result: {
      iata: airport.iata,
      name: airport.name,
      available: true,
      latest_month: summary.latestMonth,
      trailing_12_months: {
        period: `${t12.from} to ${t12.to}`,
        enplaned_passengers: t12.passengers,
        domestic_enplaned_passengers: t12.domesticPassengers,
        departures: t12.departures,
        seats: t12.seats,
        load_factor: t12.loadFactor,
        load_factor_pct: percentValue(t12.loadFactor),
      },
      prior_12_months: prior12
        ? { period: `${prior12.from} to ${prior12.to}`, enplaned_passengers: prior12.passengers }
        : null,
      passenger_growth_yoy: passengerGrowthYoy,
      ...bundledDatasetNote(airport.annual_passengers, t12.passengers, summary, deps.datasetVintage),
      source: SOURCE,
      retrieved_at: retrievedAtIso(deps, [cache.storedAt(airport.iata, nowOf(deps).getTime())]),
    },
    structured: { kind: "metric", columns: ["BTS T-100 (live query)", "Value"], rows: rowsOut },
    assumptions: [
      "Queried live from the BTS T-100 monthly summary by origin airport; totals and growth are computed from the monthly rows for the trailing 12 months versus the 12 months before.",
      "Passengers are enplaned (departing) passengers on scheduled and non-scheduled air carrier segments; load factor is passengers divided by seats.",
    ],
    uncertainty:
      `BTS publishes T-100 with a lag of several months; the latest month covered is ${summary.latestMonth}, not today. ` +
      "T-100 covers carrier segments only (not general aviation) and says nothing about delays.",
  };
}

export const btsTrafficTool: LiveTool = {
  name: "bts_airport_traffic",
  schema: {
    name: "bts_airport_traffic",
    description:
      "Official BTS T-100 traffic for one airport by IATA code, queried live: trailing-12-month " +
      "enplaned passengers, departures, seats, load factor and year-over-year passenger growth, " +
      "with the months covered. Use for questions about actual passenger volume, growth or load " +
      "factor at a specific airport.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'BOS'." } },
      required: ["iata"],
    },
  },
  handler: btsAirportTraffic,
};
