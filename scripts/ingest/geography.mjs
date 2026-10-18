// Geography layer inputs: Census CBSA/CSA/county per airport (point-in-polygon via the
// Census geocoder) and a places gazetteer (Census Gazetteer + population estimates).
// All raw responses are cached under data/.cache and checksummed by the orchestrator.
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CACHE_DIR, USER_AGENT } from "./common.mjs";
import { readCsvFile, readZippedCsv } from "./csv-stream.mjs";

export const GAZETTEER_PLACES_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip";
export const PLACE_POPULATION_URL =
  "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv";
export const GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
export const MIN_PLACE_POPULATION = 10_000;

export const GEOGRAPHY_CACHE = {
  gazetteer: `${CACHE_DIR}/census_gaz_place_2025.zip`,
  population: `${CACHE_DIR}/census_sub_est2025.csv`,
  geocoder: `${CACHE_DIR}/census_geocoder_airports.json`,
};

async function downloadOnce(url, target) {
  if (await stat(target).catch(() => null)) return;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await mkdir(CACHE_DIR, { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

export async function fetchPlaceSources() {
  await downloadOnce(GAZETTEER_PLACES_URL, GEOGRAPHY_CACHE.gazetteer);
  await downloadOnce(PLACE_POPULATION_URL, GEOGRAPHY_CACHE.population);
}

/** Pulls CBSA, CSA and county out of one geocoder response; absent layers stay null. */
export function parseGeocoderGeographies(geographies) {
  const metro = geographies["Metropolitan Statistical Areas"]?.[0];
  const micro = geographies["Micropolitan Statistical Areas"]?.[0];
  const cbsa = metro ?? micro;
  const csa = geographies["Combined Statistical Areas"]?.[0];
  const county = geographies["Counties"]?.[0];
  return {
    cbsa_code: cbsa?.GEOID ?? null,
    cbsa_name: cbsa?.BASENAME ?? null,
    cbsa_type: metro ? "metropolitan" : micro ? "micropolitan" : null,
    csa_code: csa?.GEOID ?? null,
    csa_name: csa?.BASENAME ?? null,
    county_fips: county?.GEOID ?? null,
    county_name: county?.NAME ?? null,
  };
}

async function geocodeOne(lat, lon) {
  const url = `${GEOCODER_URL}?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } }).catch(() => null);
    if (response?.ok) return (await response.json()).result?.geographies ?? {};
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error(`Census geocoder failed for ${lat},${lon}`);
}

/** airports: [{iata, lat, lon}]. Responses are cached in one JSON file keyed by IATA + coordinates. */
export async function geocodeAirports(airports) {
  const cached = JSON.parse(await readFile(GEOGRAPHY_CACHE.geocoder, "utf-8").catch(() => "{}"));
  for (const { iata, lat, lon } of airports) {
    const key = `${iata}@${lat},${lon}`;
    if (!cached[key]) cached[key] = parseGeocoderGeographies(await geocodeOne(lat, lon));
  }
  const sortedCache = Object.fromEntries(Object.entries(cached).sort(([x], [y]) => x.localeCompare(y)));
  await writeFile(GEOGRAPHY_CACHE.geocoder, JSON.stringify(sortedCache, null, 1));
  return Object.fromEntries(airports.map(({ iata, lat, lon }) => [iata, cached[`${iata}@${lat},${lon}`]]));
}

// Census legal descriptors of consolidated city-county governments. Their official names join
// the city and county ("Nashville-Davidson"); people say the city ("Nashville").
const CONSOLIDATED_GOVERNMENT = /\s(metropolitan government|metro government|consolidated government|unified government|urban county)(\s\(balance\))?$/i;

/**
 * The name people use for a place: "(balance)" dropped, and for a consolidated city-county
 * government only the city part before the first "-" or "/" ("Louisville/Jefferson County
 * metro government (balance)" -> "Louisville"). Everything else goes through cleanPlaceName.
 */
export function commonPlaceName(officialName) {
  const withoutBalance = officialName.replace(/\s\(balance\)$/i, "");
  if (CONSOLIDATED_GOVERNMENT.test(officialName)) return cleanPlaceName(withoutBalance).split(/[-/]/)[0].trim();
  return cleanPlaceName(withoutBalance);
}

/** Strips the Census legal suffix ("Boston city" -> "Boston"). */
export function cleanPlaceName(name) {
  return name.replace(/\s+(city and borough|municipality|consolidated government|metropolitan government|urban county|unified government|borough|city|town|village|CDP|municipio|zona urbana|comunidad|county|plantation)$/i, "").trim();
}

/** Joins gazetteer rows (location) with population rows (SUMLEV 162 places). Pure for testing. */
export function buildPlaces(gazetteerRows, populationRows, minPopulation = MIN_PLACE_POPULATION) {
  const population = new Map();
  for (const row of populationRows) {
    if (row.SUMLEV === "162") population.set(`${row.STATE.padStart(2, "0")}${row.PLACE.padStart(5, "0")}`, Number(row.POPESTIMATE2025));
  }
  const places = [];
  for (const row of gazetteerRows) {
    const pop = population.get(row.GEOID);
    if (!(pop >= minPopulation)) continue;
    places.push({
      name: commonPlaceName(row.NAME),
      state: row.USPS,
      lat: Number(Number(row.INTPTLAT).toFixed(4)),
      lon: Number(Number(row.INTPTLONG).toFixed(4)),
      population: pop,
      geoid: row.GEOID,
    });
  }
  return places.sort((a, b) => b.population - a.population);
}

export async function loadPlaces() {
  const gazetteerRows = [];
  for await (const row of readZippedCsv(GEOGRAPHY_CACHE.gazetteer, "|")) {
    // Pipe-delimited; the reader trims header names (the last one carries trailing whitespace).
    gazetteerRows.push(row);
  }
  const populationRows = [];
  for await (const row of readCsvFile(GEOGRAPHY_CACHE.population)) populationRows.push(row);
  if (gazetteerRows.length === 0 || populationRows.length === 0) throw new Error("places sources are empty");
  return buildPlaces(gazetteerRows, populationRows);
}
