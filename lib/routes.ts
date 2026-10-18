/**
 * Route-level T-100 rows (origin x destination x carrier x year) for the covered airports.
 *
 * data/routes.json is about 2 MB, so it is never part of the main bundle: it is loaded the
 * first time a route tool asks for it, with a dynamic import that the bundler emits as a
 * separate server chunk, then memoized. Only server-side tool code may import this module;
 * nothing in components/ or hooks/ should.
 *
 * Rows come from BTS T-100 Segment (All Carriers), scheduled passenger service, for the data
 * year and the year before (see the file's meta for the filter and source checksums).
 */

export interface RouteRow {
  year: number;
  origin: string;
  dest: string;
  /** BTS UNIQUE_CARRIER code (operating carrier, e.g. "WN", "OO"). */
  carrier: string;
  distance_mi: number;
  seats: number;
  passengers: number;
  departures: number;
}

/** The on-disk shape: compact positional rows plus the column names. */
interface RoutesFile {
  meta: { generated_at: string; columns: string[]; filter: string; sources: Record<string, unknown> };
  rows: [number, string, string, string, number, number, number, number][];
}

const EXPECTED_COLUMNS = ["year", "origin", "dest", "carrier", "distance_mi", "seats", "passengers", "departures"];

let cached: Promise<RouteRow[]> | null = null;

function toRows(file: RoutesFile): RouteRow[] {
  if (file.meta.columns.join() !== EXPECTED_COLUMNS.join()) {
    throw new Error(`data/routes.json columns changed: ${file.meta.columns.join(", ")}`);
  }
  return file.rows.map(([year, origin, dest, carrier, distance_mi, seats, passengers, departures]) => ({
    year, origin, dest, carrier, distance_mi, seats, passengers, departures,
  }));
}

/** All route rows, loaded once on first use. */
export function loadRoutes(): Promise<RouteRow[]> {
  cached ??= import("@/data/routes.json")
    .then((module) => toRows((module.default ?? module) as unknown as RoutesFile))
    .catch((error: unknown) => {
      cached = null; // a failed load is not remembered: the next call tries again
      throw new RouteDataError(error instanceof Error ? error.message : "route data could not be loaded");
    });
  return cached;
}

/** The route table could not be loaded (as opposed to the model sending bad arguments). */
export class RouteDataError extends Error {}

/** Route rows departing one airport (IATA, case-insensitive), optionally for one year. */
export async function routesFrom(origin: string, year?: number): Promise<RouteRow[]> {
  const code = origin.trim().toUpperCase();
  const rows = await loadRoutes();
  return rows.filter((r) => r.origin === code && (year === undefined || r.year === year));
}
