/**
 * Route-level agent tools over the BTS T-100 route table (lib/routes.ts):
 *   route_search    top routes from an origin airport
 *   carrier_share   seat and departure share by carrier
 *   capacity_trend  seats and passengers, 2024 vs 2025, with the biggest increases and cuts
 *   airport_search  find covered airports by place words
 *
 * Same contract as every tool in lib/tools.ts: the model sends small, validated arguments and
 * gets back a capped, aggregated result (never raw rows), while the caption, assumptions and
 * uncertainty are owned by code. Nothing here touches the network, and nothing the model
 * writes is used as a path or URL: airport codes are checked against the dataset and years
 * against a fixed set.
 */

import * as data from "./data";
import type { Airport } from "./data";
import { describeCarrier } from "./carriers";
import {
  OPERATING_CARRIER_ASSUMPTION,
  ROUTE_UNCERTAINTY,
  TREND_UNCERTAINTY,
  capacityTrendCaption,
  carrierShareCaption,
  rankingCaption,
  routeAssumptions,
  routeSearchCaption,
} from "./i18n";
import { largestRemainder, roundTo } from "./rounding";
import { loadRoutes, routesFrom, type RouteRow } from "./routes";
import { MAX_PLACE_CHARS, SCOPE_DESCRIPTION, USER_WORDS_DESCRIPTION, resolveToolScope, scopeProblem, unknownAirport } from "./toolScope";
import type { ToolOutput, ToolSchema } from "./tools";

type ToolArgs = Record<string, unknown>;

export const MAX_ROUTES = 25;
export const MAX_CARRIERS = 15;
export const MAX_TREND_ROWS = 10;
export const MAX_AIRPORTS = 25;

const INSUFFICIENT_DATA = "insufficient data";
const NOT_AVAILABLE = "n/a";
const SORT_FIELDS = ["passengers", "seats", "departures"] as const;
type SortField = (typeof SORT_FIELDS)[number];
const SORT_LABEL: Record<SortField, string> = { passengers: "passengers", seats: "seats", departures: "departures" };
const GROUP_FIELDS = ["destination", "carrier"] as const;
type GroupField = (typeof GROUP_FIELDS)[number];

// --------------------------------------------------------------------------- //
// Input validation
// --------------------------------------------------------------------------- //

type Parsed<T> = { ok: true; value: T; note?: string } | { ok: false; output: ToolOutput };

const ok = <T>(value: T, note?: string): Parsed<T> => ({ ok: true, value, note });
const fail = (error: string, extra: Record<string, unknown> = {}): Parsed<never> => ({
  ok: false,
  output: { result: { error, ...extra } },
});

const shown = (raw: unknown): string => String(raw).slice(0, 40);
const isBlank = (raw: unknown): boolean => raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
/** A trimmed, length-capped string argument (place words never need more than 200 characters). */
const text = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.trim() ? raw.trim().slice(0, MAX_PLACE_CHARS) : undefined;

/** The two calendar years the route table holds: the data year and the one before. */
function routeYears(): { prior: number; current: number } {
  return { prior: data.dataYear() - 1, current: data.dataYear() };
}

function parseYear(raw: unknown, fallback: number): Parsed<number> {
  if (isBlank(raw)) return ok(fallback);
  const { prior, current } = routeYears();
  const year = typeof raw === "string" && /^\d{4}$/.test(raw.trim()) ? Number(raw) : raw;
  if (year !== prior && year !== current) {
    return fail(`Year '${shown(raw)}' is not available. Route data covers ${prior} and ${current} only.`, {
      valid_years: [prior, current],
    });
  }
  return ok(year as number);
}

function parseChoice<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, name: string): Parsed<T> {
  if (isBlank(raw)) return ok(fallback);
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return ok(raw as T);
  return fail(`Unknown ${name} '${shown(raw)}'.`, { [`valid_${name}`]: allowed });
}

/** A whole number from 1 to `max`; a larger request is capped and says so, a non-number is an error. */
function parseCount(raw: unknown, fallback: number, max: number, name: string): Parsed<number> {
  if (isBlank(raw)) return ok(fallback);
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return fail(`${name} must be a number.`);
  const whole = Math.floor(n);
  if (whole < 1) return fail(`${name} must be at least 1.`);
  if (whole > max) return ok(max, `${name} was capped at ${max}; ask the user to narrow the question for more.`);
  return ok(whole);
}

/** An origin: a three-letter code that is one of the dataset's airports. */
function parseOrigin(raw: unknown): Parsed<Airport> {
  const code = text(raw);
  if (!code || !/^[A-Za-z]{3}$/.test(code)) {
    return fail("origin must be a three-letter IATA airport code from the dataset.", { known_airports: data.knownIatas() });
  }
  const airport = data.getAirport(code);
  return airport ? ok(airport) : { ok: false, output: unknownAirport(code.toUpperCase()) };
}

let destinationCodes: Promise<Set<string>> | null = null;

/** Every destination code present in the route table: the allow-list for a destination that is not a covered airport. */
function routeDestinations(): Promise<Set<string>> {
  destinationCodes ??= loadRoutes().then((rows) => new Set(rows.map((r) => r.dest)));
  return destinationCodes;
}

/** Rows are kept when their destination is in `codes`. */
interface DestinationFilter {
  codes: Set<string>;
  /** For captions and replies, e.g. "LAX — Los Angeles" or "Northeast". */
  label: string;
  kind: "airport" | "scope";
  /** Airports resolved from a scope; the airport itself for a code. */
  airportCount: number;
  notes: string[];
  resolvedAs?: string | null;
  /** The single destination code when the filter is one airport (a route). */
  single?: string;
}

function destinationLabel(code: string): string {
  const airport = data.getAirport(code);
  return airport ? `${airport.iata} — ${airport.city}` : code;
}

/**
 * Resolve the optional destination filter. Place words from the user win (the model tends to
 * rewrite them); an airport code outside the 102 covered airports is accepted only if it
 * appears as a destination in the route table. Scopes resolve to covered airports only.
 */
async function resolveDestination(args: ToolArgs): Promise<Parsed<DestinationFilter | null>> {
  const destination = text(args.destination);
  const words = text(args.destination_words);
  if (!destination && !words) return ok(null);

  const asCode = async (): Promise<DestinationFilter | null> => {
    if (!destination || !/^[A-Za-z]{3}$/.test(destination)) return null;
    const code = destination.toUpperCase();
    if (!data.getAirport(code) && !(await routeDestinations()).has(code)) return null;
    return { codes: new Set([code]), label: destinationLabel(code), kind: "airport", airportCount: 1, notes: [], single: code };
  };

  if (!words) {
    const code = await asCode();
    if (code) return ok(code);
  }
  const resolution = resolveToolScope(destination, words);
  if (resolution.status !== "matched") {
    const code = await asCode();
    return code ? ok(code) : { ok: false, output: scopeProblem(resolution) };
  }
  return ok({
    codes: new Set(resolution.airports.map((a) => a.iata)),
    label: resolution.label,
    kind: "scope",
    airportCount: resolution.airports.length,
    resolvedAs: resolution.resolvedAs,
    notes: [
      ...resolution.notes,
      "A destination area covers only the airports in the dataset; flights to other airports in it are not counted.",
    ],
  });
}

function destinationFacts(filter: DestinationFilter | null): Record<string, unknown> {
  if (!filter) return {};
  return {
    destination_filter: {
      label: filter.label,
      kind: filter.kind,
      airports_in_filter: filter.airportCount,
      ...(filter.resolvedAs ? { resolved_as: filter.resolvedAs } : {}),
      notes: filter.notes,
    },
  };
}

const keepDestination = (rows: RouteRow[], filter: DestinationFilter | null): RouteRow[] =>
  filter ? rows.filter((r) => filter.codes.has(r.dest)) : rows;

// --------------------------------------------------------------------------- //
// Aggregation
// --------------------------------------------------------------------------- //

interface Totals {
  seats: number;
  passengers: number;
  departures: number;
}

const emptyTotals = (): Totals => ({ seats: 0, passengers: 0, departures: 0 });

function sumRows(rows: RouteRow[]): Totals {
  const totals = emptyTotals();
  for (const r of rows) {
    totals.seats += r.seats;
    totals.passengers += r.passengers;
    totals.departures += r.departures;
  }
  return totals;
}

function groupRows(rows: RouteRow[], keyOf: (row: RouteRow) => string): Map<string, RouteRow[]> {
  const groups = new Map<string, RouteRow[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}


/** Percent change from `prior` to `current`; null when there was no prior to compare with. */
function percentChange(current: number, prior: number): number | null {
  return prior > 0 ? roundTo(((current - prior) / prior) * 100) : null;
}

const signedPercent = (pct: number | null, fallback: string): string =>
  pct === null ? fallback : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;

function carrierFacts(code: string): { code: string; name: string | null; operating_carrier: boolean; label: string } {
  const info = describeCarrier(code);
  return { code, name: info.name, operating_carrier: info.operatingCarrier, label: info.label };
}

const usesOperatingCarrier = (codes: string[]): boolean => codes.some((code) => describeCarrier(code).operatingCarrier);

function noService(origin: Airport, filter: DestinationFilter | null, years: number[]): ToolOutput {
  const to = filter ? ` to ${filter.label}` : "";
  return {
    result: {
      iata: origin.iata,
      no_service: true,
      message:
        `No nonstop service in this data from ${origin.iata}${to} in ${years.join(" or ")} ` +
        "(BTS T-100 scheduled passenger segments). Say exactly that; do not call the market underserved or unserved.",
      ...destinationFacts(filter),
    },
    uncertainty: ROUTE_UNCERTAINTY,
  };
}

function baseAssumptions(years: number[], carrierCodes: string[]): string[] {
  return [
    ...routeAssumptions({ years: years.join(" and "), coveredAirports: data.allAirports().length }),
    ...(usesOperatingCarrier(carrierCodes) ? [OPERATING_CARRIER_ASSUMPTION] : []),
  ];
}

// --------------------------------------------------------------------------- //
// route_search
// --------------------------------------------------------------------------- //

const TOP_CARRIERS_PER_ROUTE = 3;

export async function routeSearch(args: ToolArgs): Promise<ToolOutput> {
  const origin = parseOrigin(args.origin);
  if (!origin.ok) return origin.output;
  const year = parseYear(args.year, routeYears().current);
  if (!year.ok) return year.output;
  const sortBy = parseChoice(args.sort_by, SORT_FIELDS, "passengers", "sort_by");
  if (!sortBy.ok) return sortBy.output;
  const topN = parseCount(args.top_n, 10, MAX_ROUTES, "top_n");
  if (!topN.ok) return topN.output;
  const destination = await resolveDestination(args);
  if (!destination.ok) return destination.output;

  const { prior } = routeYears();
  const compareWithPrior = year.value > prior;
  const currentRows = keepDestination(await routesFrom(origin.value.iata, year.value), destination.value);
  if (currentRows.length === 0) return noService(origin.value, destination.value, [year.value]);
  const priorByDest = compareWithPrior
    ? groupRows(keepDestination(await routesFrom(origin.value.iata, prior), destination.value), (r) => r.dest)
    : new Map<string, RouteRow[]>();

  const field: SortField = sortBy.value;
  const entries = [...groupRows(currentRows, (r) => r.dest)].map(([dest, rows]) => {
    const totals = sumRows(rows);
    const bySeats = [...rows].sort((a, b) => b.seats - a.seats);
    const carrierSeats = [...groupRows(rows, (r) => r.carrier)]
      .map(([code, group]) => ({ code, seats: sumRows(group).seats }))
      .sort((a, b) => b.seats - a.seats || a.code.localeCompare(b.code));
    const previousRows = priorByDest.get(dest);
    const yoy = previousRows ? percentChange(totals[field], sumRows(previousRows)[field]) : null;
    return { dest, totals, distance_mi: bySeats[0].distance_mi, carrierSeats, hadPrior: Boolean(previousRows), yoy };
  });
  entries.sort((a, b) => b.totals[field] - a.totals[field] || a.dest.localeCompare(b.dest));

  const top = entries.slice(0, topN.value);
  const yoyNote = (e: (typeof entries)[number]): string | undefined =>
    !compareWithPrior ? undefined : e.hadPrior ? undefined : `no service in ${prior}`;
  const yoyColumn = `${SORT_LABEL[field][0].toUpperCase()}${SORT_LABEL[field].slice(1)} YoY`;

  const routes = top.map((e, i) => ({
    rank: i + 1,
    destination: e.dest,
    destination_name: data.getAirport(e.dest)?.city ?? null,
    carriers: e.carrierSeats.slice(0, TOP_CARRIERS_PER_ROUTE).map((c) => ({ ...carrierFacts(c.code), seats: c.seats })),
    other_carrier_count: Math.max(0, e.carrierSeats.length - TOP_CARRIERS_PER_ROUTE),
    passengers: e.totals.passengers,
    seats: e.totals.seats,
    departures: e.totals.departures,
    distance_mi: e.distance_mi,
    yoy_pct: e.yoy,
    ...(yoyNote(e) ? { yoy_note: yoyNote(e) } : {}),
  }));

  const carrierCell = (e: (typeof top)[number]): string => {
    const names = e.carrierSeats.slice(0, TOP_CARRIERS_PER_ROUTE).map((c) => describeCarrier(c.code).name ?? c.code);
    const more = e.carrierSeats.length - names.length;
    return more > 0 ? `${names.join(", ")} +${more} more` : names.join(", ");
  };
  const rows = top.map((e, i) => [
    i + 1,
    destinationLabel(e.dest),
    carrierCell(e),
    e.totals.passengers,
    e.totals.seats,
    e.totals.departures,
    e.distance_mi,
    compareWithPrior ? signedPercent(e.yoy, e.hadPrior ? NOT_AVAILABLE : "new") : NOT_AVAILABLE,
  ]);

  const years = compareWithPrior ? [prior, year.value] : [year.value];
  const notes = topN.note ? [topN.note] : [];
  return {
    result: {
      origin: origin.value.iata,
      origin_name: origin.value.name,
      year: year.value,
      sort_by: field,
      ...destinationFacts(destination.value),
      row_count: entries.length,
      returned: routes.length,
      truncated: entries.length > routes.length,
      ...(compareWithPrior ? {} : { yoy_note: `${year.value} is the earliest year in the data, so no change is shown.` }),
      ...(notes.length > 0 ? { notes } : {}),
      note: "passengers are enplaned per segment; carriers are BTS operating-carrier codes (names from the BTS lookup, raw code if unknown).",
      routes,
    },
    structured: {
      kind: "metric",
      columns: ["Rank", "Destination", "Carriers", "Passengers", "Seats", "Departures", "Distance (mi)", yoyColumn],
      rows,
      caption: routeSearchCaption({
        origin: origin.value.iata,
        year: year.value,
        destination: destination.value?.label ?? null,
        shown: routes.length,
        total: entries.length,
        sortLabel: SORT_LABEL[field],
      }),
    },
    assumptions: baseAssumptions(years, top.flatMap((e) => e.carrierSeats.map((c) => c.code))),
    uncertainty: ROUTE_UNCERTAINTY,
  };
}

// --------------------------------------------------------------------------- //
// carrier_share
// --------------------------------------------------------------------------- //

export async function carrierShare(args: ToolArgs): Promise<ToolOutput> {
  const origin = parseOrigin(args.origin);
  if (!origin.ok) return origin.output;
  const year = parseYear(args.year, routeYears().current);
  if (!year.ok) return year.output;
  const topN = parseCount(args.top_n, 8, MAX_CARRIERS, "top_n");
  if (!topN.ok) return topN.output;
  const destination = await resolveDestination(args);
  if (!destination.ok) return destination.output;

  const rows = keepDestination(await routesFrom(origin.value.iata, year.value), destination.value);
  if (rows.length === 0) return noService(origin.value, destination.value, [year.value]);

  const total = sumRows(rows);
  const rowsByCarrier = groupRows(rows, (r) => r.carrier);
  const carriers = [...rowsByCarrier]
    .map(([code, group]) => ({ code, totals: sumRows(group) }))
    .sort((a, b) => b.totals.seats - a.totals.seats || b.totals.departures - a.totals.departures || a.code.localeCompare(b.code));
  const top = carriers.slice(0, topN.value);
  const rest = carriers.slice(topN.value);
  const restTotals = sumRows(rest.flatMap((c) => rowsByCarrier.get(c.code) ?? []));

  // One largest-remainder pass over every row, Other included, so the displayed shares add up to
  // exactly 100.0 and none can be negative (rounding each share separately drifts by 0.1-0.2).
  const sharesOf = (parts: number[], whole: number): (number | null)[] =>
    whole > 0 ? largestRemainder(parts.map((part) => (part / whole) * 100), 100, 1) : parts.map(() => null);
  const seatShares = sharesOf([...top.map((c) => c.totals.seats), ...(rest.length > 0 ? [restTotals.seats] : [])], total.seats);
  const departureShares = sharesOf(
    [...top.map((c) => c.totals.departures), ...(rest.length > 0 ? [restTotals.departures] : [])],
    total.departures,
  );

  const entries = top.map((c, i) => ({
    ...carrierFacts(c.code),
    seats: c.totals.seats,
    seat_share_pct: seatShares[i],
    departures: c.totals.departures,
    departure_share_pct: departureShares[i],
  }));
  const other =
    rest.length > 0
      ? {
          carrier_count: rest.length,
          seats: restTotals.seats,
          seat_share_pct: seatShares[top.length],
          departures: restTotals.departures,
          departure_share_pct: departureShares[top.length],
        }
      : null;

  const cell = (pct: number | null): number | string => (pct === null ? INSUFFICIENT_DATA : pct);
  const tableRows = [
    ...entries.map((e) => [e.label as string, e.seats, cell(e.seat_share_pct), e.departures, cell(e.departure_share_pct)]),
    ...(other
      ? [[`Other (${other.carrier_count} carriers)`, other.seats, cell(other.seat_share_pct), other.departures, cell(other.departure_share_pct)]]
      : []),
  ];

  return {
    result: {
      origin: origin.value.iata,
      origin_name: origin.value.name,
      year: year.value,
      ...destinationFacts(destination.value),
      total_seats: total.seats,
      total_departures: total.departures,
      row_count: carriers.length,
      returned: entries.length,
      truncated: carriers.length > entries.length,
      ...(topN.note ? { notes: [topN.note] } : {}),
      note: "Shares are of seats and of departures performed. 'other' groups the remaining carriers so the shares add up to 100%.",
      carriers: entries,
      other,
    },
    structured: {
      kind: "metric",
      columns: ["Carrier", "Seats", "Seat share (%)", "Departures", "Departure share (%)"],
      rows: tableRows,
      caption: carrierShareCaption({
        origin: origin.value.iata,
        year: year.value,
        destination: destination.value?.label ?? null,
        shown: entries.length,
        total: carriers.length,
      }),
    },
    assumptions: baseAssumptions([year.value], top.map((c) => c.code)),
    uncertainty: ROUTE_UNCERTAINTY,
  };
}

// --------------------------------------------------------------------------- //
// capacity_trend
// --------------------------------------------------------------------------- //

interface Movement {
  key: string;
  label: string;
  priorSeats: number;
  seats: number;
  priorPassengers: number;
  passengers: number;
  carrierCode?: string;
}

const seatChange = (m: Movement): number => m.seats - m.priorSeats;

function describeMovement(m: Movement): Record<string, unknown> {
  const status = m.priorSeats === 0 && m.seats > 0 ? "new" : m.seats === 0 && m.priorSeats > 0 ? "ended" : undefined;
  return {
    key: m.key,
    label: m.label,
    ...(m.carrierCode ? { operating_carrier: describeCarrier(m.carrierCode).operatingCarrier } : {}),
    seats_prior: m.priorSeats,
    seats_current: m.seats,
    seats_change: seatChange(m),
    seats_change_pct: percentChange(m.seats, m.priorSeats),
    passengers_prior: m.priorPassengers,
    passengers_current: m.passengers,
    passengers_change: m.passengers - m.priorPassengers,
    passengers_change_pct: percentChange(m.passengers, m.priorPassengers),
    ...(status ? { status } : {}),
  };
}

function movements(prior: RouteRow[], current: RouteRow[], groupBy: GroupField): Movement[] {
  const keyOf = (r: RouteRow): string => (groupBy === "carrier" ? r.carrier : r.dest);
  const priorGroups = groupRows(prior, keyOf);
  const currentGroups = groupRows(current, keyOf);
  const keys = new Set([...priorGroups.keys(), ...currentGroups.keys()]);
  return [...keys].map((key) => {
    const before = sumRows(priorGroups.get(key) ?? []);
    const now = sumRows(currentGroups.get(key) ?? []);
    return {
      key,
      label: groupBy === "carrier" ? describeCarrier(key).label : destinationLabel(key),
      priorSeats: before.seats,
      seats: now.seats,
      priorPassengers: before.passengers,
      passengers: now.passengers,
      ...(groupBy === "carrier" ? { carrierCode: key } : {}),
    };
  });
}

export async function capacityTrend(args: ToolArgs): Promise<ToolOutput> {
  const origin = parseOrigin(args.origin);
  if (!origin.ok) return origin.output;
  const destination = await resolveDestination(args);
  if (!destination.ok) return destination.output;
  // A single route is best explained by who flies it; an airport or an area by where it goes.
  const defaultGroup: GroupField = destination.value?.single ? "carrier" : "destination";
  const groupBy = parseChoice(args.group_by, GROUP_FIELDS, defaultGroup, "group_by");
  if (!groupBy.ok) return groupBy.output;
  const topN = parseCount(args.top_n, 5, MAX_TREND_ROWS, "top_n");
  if (!topN.ok) return topN.output;

  const { prior: priorYear, current: year } = routeYears();
  const priorRows = keepDestination(await routesFrom(origin.value.iata, priorYear), destination.value);
  const currentRows = keepDestination(await routesFrom(origin.value.iata, year), destination.value);
  if (priorRows.length === 0 && currentRows.length === 0) return noService(origin.value, destination.value, [priorYear, year]);

  const all = movements(priorRows, currentRows, groupBy.value);
  const increases = all.filter((m) => seatChange(m) > 0).sort((a, b) => seatChange(b) - seatChange(a) || a.key.localeCompare(b.key));
  const cuts = all.filter((m) => seatChange(m) < 0).sort((a, b) => seatChange(a) - seatChange(b) || a.key.localeCompare(b.key));
  const shownIncreases = increases.slice(0, topN.value);
  const shownCuts = cuts.slice(0, topN.value);

  const before = sumRows(priorRows);
  const now = sumRows(currentRows);
  const totals = {
    seats_prior: before.seats,
    seats_current: now.seats,
    seats_change: now.seats - before.seats,
    seats_change_pct: percentChange(now.seats, before.seats),
    passengers_prior: before.passengers,
    passengers_current: now.passengers,
    passengers_change: now.passengers - before.passengers,
    passengers_change_pct: percentChange(now.passengers, before.passengers),
  };

  const groupColumn = groupBy.value === "carrier" ? "Carrier" : "Destination";
  const tableRow = (kind: string, label: string, t: Record<string, unknown>): (string | number)[] => [
    kind,
    label,
    t.seats_prior as number,
    t.seats_current as number,
    t.seats_change as number,
    signedPercent(t.seats_change_pct as number | null, t.status === "new" ? "new" : NOT_AVAILABLE),
    t.passengers_prior as number,
    t.passengers_current as number,
    signedPercent(t.passengers_change_pct as number | null, t.status === "new" ? "new" : NOT_AVAILABLE),
  ];
  const describedIncreases = shownIncreases.map(describeMovement);
  const describedCuts = shownCuts.map(describeMovement);
  const scopeLabel = destination.value ? destination.value.label : `all destinations from ${origin.value.iata}`;

  const carrierCodes = groupBy.value === "carrier" ? [...shownIncreases, ...shownCuts].map((m) => m.key) : [...priorRows, ...currentRows].map((r) => r.carrier);
  return {
    result: {
      origin: origin.value.iata,
      origin_name: origin.value.name,
      years: { prior: priorYear, current: year },
      group_by: groupBy.value,
      ...destinationFacts(destination.value),
      totals,
      groups_with_increase: increases.length,
      groups_with_cut: cuts.length,
      row_count: increases.length + cuts.length,
      returned: describedIncreases.length + describedCuts.length,
      truncated: increases.length > shownIncreases.length || cuts.length > shownCuts.length,
      ...(topN.note ? { notes: [topN.note] } : {}),
      note: `Seat change is the ranking measure. Groups with no change are omitted. A 'new' group had no service in ${priorYear}; 'ended' had none in ${year}.`,
      biggest_increases: describedIncreases,
      biggest_cuts: describedCuts,
    },
    structured: {
      kind: "metric",
      columns: ["Change", groupColumn, `Seats ${priorYear}`, `Seats ${year}`, "Seat change", "Seat change (%)", `Passengers ${priorYear}`, `Passengers ${year}`, "Passenger change (%)"],
      rows: [
        tableRow("Total", scopeLabel, totals),
        ...describedIncreases.map((m) => tableRow("Increase", m.label as string, m)),
        ...describedCuts.map((m) => tableRow("Cut", m.label as string, m)),
      ],
      caption: capacityTrendCaption({
        origin: origin.value.iata,
        destination: destination.value?.label ?? null,
        priorYear,
        year,
        groupBy: groupBy.value,
      }),
    },
    assumptions: baseAssumptions([priorYear, year], carrierCodes),
    uncertainty: `${ROUTE_UNCERTAINTY} ${TREND_UNCERTAINTY}`,
  };
}

// --------------------------------------------------------------------------- //
// airport_search
// --------------------------------------------------------------------------- //

export async function airportSearch(args: ToolArgs): Promise<ToolOutput> {
  const scope = text(args.scope);
  const words = text(args.user_words);
  if (!scope && !words) {
    return { result: { error: "Pass the user's place words in user_words (and scope) so the airports can be found." } };
  }
  const topN = parseCount(args.top_n, 10, MAX_AIRPORTS, "top_n");
  if (!topN.ok) return topN.output;

  const resolution = resolveToolScope(scope, words);
  if (resolution.status !== "matched") return scopeProblem(resolution);

  const year = data.dataYear();
  const matched = [...resolution.airports].sort((a, b) => b.annual_passengers - a.annual_passengers || a.iata.localeCompare(b.iata));
  const top = matched.slice(0, topN.value);
  const passengersOf = (a: Airport): number | null => (Number.isFinite(a.annual_passengers) ? a.annual_passengers : null);

  return {
    result: {
      scope: scope ?? null,
      scope_resolved_as: resolution.resolvedAs,
      scope_label: resolution.label,
      scope_notes: resolution.notes,
      year,
      row_count: matched.length,
      returned: top.length,
      truncated: matched.length > top.length,
      ...(topN.note ? { notes: [topN.note] } : {}),
      note: "Only airports in the dataset can be listed. A null passenger figure is insufficient data, never zero.",
      airports: top.map((a) => ({
        iata: a.iata,
        name: a.name,
        city: a.city,
        state: a.state,
        metro_area: a.metro ?? null,
        passengers: passengersOf(a),
      })),
    },
    structured: {
      kind: "metric",
      columns: ["Airport", "State", "Metro area", `Passengers ${year}`],
      rows: top.map((a) => [`${a.iata} — ${a.city}`, a.state, a.metro ?? NOT_AVAILABLE, passengersOf(a) ?? INSUFFICIENT_DATA]),
      caption: rankingCaption({
        label: resolution.label,
        resolvedAs: resolution.resolvedAs!,
        readFrom: resolution.reinterpreted ? resolution.input : undefined,
        matched: matched.length,
        shown: top.length,
        scoreLabel: `${year} passengers`,
      }),
    },
    assumptions: [`Airport scope is limited to the ${data.allAirports().length} U.S. airports in the dataset; passengers are enplaned passengers in ${year} (BTS T-100).`],
    uncertainty: null,
  };
}

// --------------------------------------------------------------------------- //
// Dispatch + schemas
// --------------------------------------------------------------------------- //

export const ROUTE_TOOLS: Record<string, (args: ToolArgs) => Promise<ToolOutput>> = {
  route_search: routeSearch,
  carrier_share: carrierShare,
  capacity_trend: capacityTrend,
  airport_search: airportSearch,
};

const ORIGIN_SCHEMA = {
  type: "string",
  description: "IATA code of the origin airport; must be one of the dataset's airports, e.g. 'BOS'.",
};

const DESTINATION_SCHEMA = {
  destination: {
    type: "string",
    description:
      "Optional. A destination airport code (e.g. 'LAX', or 'LHR' for a non-covered airport that appears in the route data), " +
      "or the destination place words. Leave out to include every destination.",
  },
  destination_words: {
    type: "string",
    description:
      "The destination place words copied exactly from the user's latest message (e.g. 'Florida', 'the Northeast'). " +
      "Code resolves these to covered airports and prefers them over 'destination'. Fill in when the user named a destination area.",
  },
};

const YEAR_SCHEMA = { type: "integer", enum: [2024, 2025], description: "Calendar year; 2025 (the latest complete year) by default." };

export function routeToolSchemas(): ToolSchema[] {
  return [
    {
      name: "route_search",
      description:
        "Top routes (destinations) departing one dataset airport, ranked by passengers, seats or departures for 2024 or 2025, " +
        "with carriers, distance and the change from 2024. Use for 'where does X fly', 'top routes from X', 'is there nonstop " +
        "service from X to Y', 'flights from X to <area>'. Returns at most 25 rows with row_count and a truncated flag.",
      input_schema: {
        type: "object",
        properties: {
          origin: ORIGIN_SCHEMA,
          ...DESTINATION_SCHEMA,
          year: YEAR_SCHEMA,
          sort_by: { type: "string", enum: [...SORT_FIELDS], description: "Ranking measure (default passengers)." },
          top_n: { type: "integer", description: `How many routes (default 10, at most ${MAX_ROUTES}).` },
        },
        required: ["origin"],
      },
    },
    {
      name: "carrier_share",
      description:
        "Seat and departure share by carrier at one dataset airport, or on a route / to a destination area, with the top N carriers " +
        "and an 'other' bucket. Use for 'who dominates X', 'how much of X is Southwest', 'which airlines fly X to Y'. " +
        "Carriers are BTS operating carriers; regional airlines may fly under another brand.",
      input_schema: {
        type: "object",
        properties: {
          origin: ORIGIN_SCHEMA,
          ...DESTINATION_SCHEMA,
          year: YEAR_SCHEMA,
          top_n: { type: "integer", description: `How many carriers before 'other' (default 8, at most ${MAX_CARRIERS}).` },
        },
        required: ["origin"],
      },
    },
    {
      name: "capacity_trend",
      description:
        "Seats and passengers in 2024 vs 2025 for an airport, a route, or an airport to a destination area, with the percent change " +
        "and the biggest increases and cuts by destination or carrier. Use for 'why did X fall', 'which airlines cut capacity at X', " +
        "'where did seats grow'. It shows what changed, not why.",
      input_schema: {
        type: "object",
        properties: {
          origin: ORIGIN_SCHEMA,
          ...DESTINATION_SCHEMA,
          group_by: {
            type: "string",
            enum: [...GROUP_FIELDS],
            description: "Break the changes down by destination or by carrier (default destination; carrier for a single route).",
          },
          top_n: { type: "integer", description: `How many increases and cuts each (default 5, at most ${MAX_TREND_ROWS}).` },
        },
        required: ["origin"],
      },
    },
    {
      name: "airport_search",
      description:
        "Find the dataset's airports for a place (city, metro, state, region, 'near <place>'), with state, metro area and 2025 " +
        "passengers. Use to answer 'which airports are in/near X' before asking about routes. Only covered airports are returned.",
      input_schema: {
        type: "object",
        properties: {
          scope: { type: "string", description: SCOPE_DESCRIPTION },
          user_words: { type: "string", description: USER_WORDS_DESCRIPTION },
          top_n: { type: "integer", description: `How many airports (default 10, at most ${MAX_AIRPORTS}).` },
        },
        required: ["user_words"],
      },
    },
  ];
}
