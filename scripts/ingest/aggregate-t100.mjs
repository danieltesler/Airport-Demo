// Pure aggregation of BTS T-100 Segment rows into per-airport and per-route totals.
// No I/O here except the thin stream driver at the bottom, so the rules are unit-testable.
import { readZippedCsv } from "./csv-stream.mjs";

export const HAUL_SHORT_MAX_MILES = 1100;
export const HAUL_LONG_MIN_MILES = 2200;
// Below this many passenger departures a ratio is too noisy to publish (about one a day).
export const MIN_DEPARTURES_FOR_RATIOS = 365;

// CLASS F = scheduled passenger/cargo service. G/P (all-cargo) and L (charter) are excluded.
// AIRCRAFT_CONFIG 2 = freight configuration: excluded so cargo hubs (ANC, MEM) are not distorted.
const SCHEDULED_PASSENGER_CLASS = "F";
const FREIGHT_CONFIG = "2";

export function isScheduledPassengerRow(row) {
  return row.CLASS === SCHEDULED_PASSENGER_CLASS && row.AIRCRAFT_CONFIG !== FREIGHT_CONFIG;
}

export function haulBucket(distanceMiles) {
  if (!(distanceMiles > 0)) return null;
  if (distanceMiles < HAUL_SHORT_MAX_MILES) return "short";
  return distanceMiles > HAUL_LONG_MIN_MILES ? "long" : "medium";
}

function emptyAirport(row) {
  return {
    cityMarketId: row.ORIGIN_CITY_MARKET_ID,
    cityName: row.ORIGIN_CITY_NAME,
    passengers: 0, domesticPassengers: 0, seats: 0, departures: 0, haulDepartures: { short: 0, medium: 0, long: 0 } };
}

export function createT100Accumulator() {
  return { airports: new Map(), routes: new Map(), rowsRead: 0, rowsUsed: 0 };
}

export function addT100Row(acc, row) {
  acc.rowsRead++;
  if (!isScheduledPassengerRow(row) || row.ORIGIN_COUNTRY !== "US") return;
  const departures = Number(row.DEPARTURES_PERFORMED);
  if (!(departures > 0)) return;
  acc.rowsUsed++;
  const seats = Number(row.SEATS);
  const passengers = Number(row.PASSENGERS);
  const distance = Number(row.DISTANCE);

  const airport = acc.airports.get(row.ORIGIN) ?? emptyAirport(row);
  airport.passengers += passengers;
  if (row.DEST_COUNTRY === "US") airport.domesticPassengers += passengers;
  airport.seats += seats;
  airport.departures += departures;
  const bucket = haulBucket(distance);
  if (bucket) airport.haulDepartures[bucket] += departures;
  acc.airports.set(row.ORIGIN, airport);

  const routeKey = `${row.ORIGIN}|${row.DEST}|${row.UNIQUE_CARRIER}`;
  const route = acc.routes.get(routeKey) ?? { distance, seats: 0, passengers: 0, departures: 0 };
  route.seats += seats;
  route.passengers += passengers;
  route.departures += departures;
  acc.routes.set(routeKey, route);
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/** Ratios are null, never defaulted, when the airport has too few departures to be meaningful. */
export function finalizeAirport(totals) {
  const enough = totals.departures >= MIN_DEPARTURES_FOR_RATIOS;
  const classified = Object.values(totals.haulDepartures).reduce((a, b) => a + b, 0);
  const loadFactor = enough && totals.seats > 0 ? totals.passengers / totals.seats : null;
  const haulMix =
    enough && classified > 0
      ? Object.fromEntries(Object.entries(totals.haulDepartures).map(([k, v]) => [k, round(v / classified, 4)]))
      : null;
  return {
    bts_city_market_id: totals.cityMarketId ? Number(totals.cityMarketId) : null,
    bts_city_name: totals.cityName || null,
    passengers: totals.passengers,
    domestic_passengers: totals.domesticPassengers,
    international_share: totals.passengers > 0 ? round(1 - totals.domesticPassengers / totals.passengers, 4) : null,
    seats: totals.seats,
    departures: totals.departures,
    load_factor: loadFactor === null ? null : round(loadFactor, 4),
    haul_mix: haulMix,
  };
}

export async function aggregateT100Zip(zipPath) {
  const acc = createT100Accumulator();
  for await (const row of readZippedCsv(zipPath)) addT100Row(acc, row);
  if (acc.rowsUsed === 0) throw new Error(`no scheduled passenger rows found in ${zipPath}; schema may have changed`);
  return acc;
}

/** Year-over-year growth, null when either year is missing or the base is zero. */
export function yearOverYearGrowth(current, previous) {
  if (!(previous > 0) || current === undefined) return null;
  return round(current / previous - 1, 4);
}
