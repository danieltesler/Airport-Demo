// OurAirports reference data (name, location) and OPEN runway counts.
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CACHE_DIR, USER_AGENT } from "./common.mjs";
import { readCsvFile } from "./csv-stream.mjs";

const BASE = "https://davidmegginson.github.io/ourairports-data";
export const OURAIRPORTS_FILES = { airports: "airports.csv", runways: "runways.csv" };

export function ourAirportsUrl(name) {
  return `${BASE}/${name}`;
}

export function ourAirportsCachePath(name) {
  return `${CACHE_DIR}/ourairports_${name}`;
}

export async function fetchOurAirports() {
  await mkdir(CACHE_DIR, { recursive: true });
  const paths = {};
  for (const [key, name] of Object.entries(OURAIRPORTS_FILES)) {
    const target = ourAirportsCachePath(name);
    paths[key] = target;
    if (await stat(target).catch(() => null)) continue;
    const response = await fetch(ourAirportsUrl(name), { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`OurAirports ${name} returned ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  }
  return paths;
}

// BTS counts US territories as US origins; OurAirports files them under their own country code.
const US_COUNTRY_CODES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);
// BTS keeps the traditional code where OurAirports has re-coded the airport (PBI, West Palm Beach,
// is DJT in OurAirports since the 2025 renaming). Verified by hand against the downloaded files.
export const BTS_CODE_TO_OURAIRPORTS_IDENT = { PBI: "KPBI" };
const HELIPAD_IDENT = /^H\d*$/i;

/** Counts runways per airport ident: open ones, plus the legacy all-rows count for comparison. */
export function countRunways(rows) {
  const counts = new Map();
  for (const row of rows) {
    const entry = counts.get(row.airport_ident) ?? { open: 0, legacyAllRows: 0 };
    entry.legacyAllRows++;
    if (row.closed !== "1" && !HELIPAD_IDENT.test(row.le_ident ?? "")) entry.open++;
    counts.set(row.airport_ident, entry);
  }
  return counts;
}

export async function loadReference(paths) {
  const airports = new Map();
  const byIdent = new Map(Object.entries(BTS_CODE_TO_OURAIRPORTS_IDENT).map(([bts, ident]) => [ident, bts]));
  for await (const row of readCsvFile(paths.airports)) {
    const code = byIdent.get(row.ident) ?? row.iata_code;
    if (code && US_COUNTRY_CODES.has(row.iso_country)) {
      airports.set(code, {
        icao: row.ident,
        name: row.name,
        city: row.municipality,
        state: row.iso_country === "US" ? row.iso_region.replace(/^US-/, "") : row.iso_country,
        lat: Number(Number(row.latitude_deg).toFixed(4)),
        lon: Number(Number(row.longitude_deg).toFixed(4)),
        type: row.type,
      });
    }
  }
  const runwayRows = [];
  for await (const row of readCsvFile(paths.runways)) runwayRows.push(row);
  return { airports, runwayCounts: countRunways(runwayRows) };
}
