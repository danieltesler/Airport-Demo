// Builds the STAGING dataset (data/staging/*.next.json + provenance manifest) from real BTS,
// OurAirports and Census files. It never touches data/airports.json and never falls back to
// old numbers: anything it cannot compute is null and listed in the manifest.
//
//   npm run build:data:staging
//
// Runtime is dominated by the On-Time downloads (about 12 x 30 MB) and a few minutes of streaming.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { MANUAL_DIR, ROOT, STAGING_DIR, fail, sha256OfFile } from "./common.mjs";
import { fetchT100Year, t100CachePath } from "./fetch-t100.mjs";
import { fetchOntimeYear, ontimeCachePath, ontimeUrl } from "./fetch-ontime.mjs";
import { aggregateT100Zip, finalizeAirport, yearOverYearGrowth, HAUL_LONG_MIN_MILES, HAUL_SHORT_MAX_MILES, MIN_DEPARTURES_FOR_RATIOS } from "./aggregate-t100.mjs";
import { aggregateOntimeZips, finalizeOntimeAirport, MIN_SCHEDULED_DEPARTURES } from "./aggregate-ontime.mjs";
import { fetchOurAirports, loadReference, ourAirportsCachePath, ourAirportsUrl } from "./reference.mjs";
import { GAZETTEER_PLACES_URL, GEOCODER_URL, GEOGRAPHY_CACHE, MIN_PLACE_POPULATION, PLACE_POPULATION_URL, fetchPlaceSources, geocodeAirports, loadPlaces } from "./geography.mjs";
import { GUARANTEED_IATAS, selectCoverage } from "./coverage.mjs";

const CURRENT_YEAR = 2025;
const PREVIOUS_YEAR = 2024;
const TOP_AIRPORT_COUNT = 100;
const T100_FORM_URL = "https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG";

async function fileFacts(path, url, extra) {
  const info = await stat(path);
  return { url, file: path.replace(ROOT, ""), bytes: info.size, retrieved_at: info.mtime.toISOString(), sha256: await sha256OfFile(path), ...extra };
}

async function resolveT100Zip(year) {
  const manual = `${MANUAL_DIR}/t100_segment_all_carriers_${year}.zip`;
  if (await stat(manual).catch(() => null)) return manual;
  await fetchT100Year(year);
  return t100CachePath(year);
}

function buildAirportRecord(iata, ctx) {
  const current = finalizeAirport(ctx.t100Current.airports.get(iata));
  const previousTotals = ctx.t100Previous.airports.get(iata);
  const ontime = finalizeOntimeAirport(ctx.ontime.airports.get(iata) ?? { scheduled: 0, cancelled: 0, measured: 0, delayMinutes: 0, delayed15: 0 });
  const reference = ctx.reference.airports.get(iata);
  if (!reference) fail(`${iata} has no OurAirports record`);
  const runways = ctx.reference.runwayCounts.get(reference.icao) ?? { open: 0, legacyAllRows: 0 };
  const geo = ctx.geography[iata];
  return {
    iata,
    icao: reference.icao,
    name: reference.name,
    city: reference.city,
    state: reference.state,
    lat: reference.lat,
    lon: reference.lon,
    bts_city_market_id: current.bts_city_market_id,
    bts_city_name: current.bts_city_name,
    cbsa_code: geo.cbsa_code,
    cbsa_name: geo.cbsa_name,
    cbsa_type: geo.cbsa_type,
    csa_code: geo.csa_code,
    csa_name: geo.csa_name,
    county_fips: geo.county_fips,
    county_name: geo.county_name,
    runways: runways.open,
    runways_legacy_count: runways.legacyAllRows,
    annual_passengers: current.passengers,
    annual_departures: current.departures,
    international_passengers: current.international_passengers,
    international_passenger_share: current.international_share,
    previous_year_passengers: previousTotals?.passengers ?? null,
    pax_growth_yoy: yearOverYearGrowth(current.passengers, previousTotals?.passengers),
    load_factor: current.load_factor,
    haul_mix: current.haul_mix,
    avg_dep_delay_min: ontime.avg_dep_delay_min,
    delayed_share: ontime.delayed_share,
    cancel_rate: ontime.cancel_rate,
    ontime_scheduled_departures: ontime.scheduled_departures,
  };
}

function buildRoutes(t100ByYear, selectedIatas) {
  const rows = [];
  for (const [year, acc] of t100ByYear) {
    for (const [key, route] of acc.routes) {
      const [origin, dest, carrier] = key.split("|");
      if (!selectedIatas.has(origin)) continue;
      rows.push([year, origin, dest, carrier, route.distance, route.seats, route.passengers, route.departures]);
    }
  }
  rows.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]) || b[6] - a[6] || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]));
  return rows;
}

function fieldProvenance() {
  const t100Filter = "T-100 Segment (All Carriers), CLASS=F (scheduled passenger/cargo), AIRCRAFT_CONFIG<>2 (not freight config), ORIGIN_COUNTRY=US, DEPARTURES_PERFORMED>0";
  const ontimeNote = `On-Time Reporting Carrier, origin airport, CY${CURRENT_YEAR}; null if fewer than ${MIN_SCHEDULED_DEPARTURES} scheduled departures`;
  return {
    annual_passengers: { sources: ["bts_t100_current"], formula: `SUM(PASSENGERS) by ORIGIN, CY${CURRENT_YEAR}`, filter: t100Filter, note: "enplaned passengers, domestic + international, all carriers" },
    international_passengers: { sources: ["bts_t100_current"], formula: `SUM(PASSENGERS) on segments with DEST_COUNTRY<>US by ORIGIN, CY${CURRENT_YEAR} (exact count; the share below is this over annual_passengers, rounded)`, filter: t100Filter },
    previous_year_passengers: { sources: ["bts_t100_previous"], formula: `SUM(PASSENGERS) by ORIGIN, CY${PREVIOUS_YEAR}`, filter: t100Filter, note: "exact prior-year count behind pax_growth_yoy; null if no CY2024 base" },
    international_passenger_share: { sources: ["bts_t100_current"], formula: "1 - passengers on segments with DEST_COUNTRY=US / all passengers (territories count as US)", filter: t100Filter },
    annual_departures: { sources: ["bts_t100_current"], formula: `SUM(DEPARTURES_PERFORMED) by ORIGIN, CY${CURRENT_YEAR}`, filter: t100Filter },
    pax_growth_yoy: { sources: ["bts_t100_current", "bts_t100_previous"], formula: `passengers CY${CURRENT_YEAR} / passengers CY${PREVIOUS_YEAR} - 1`, filter: t100Filter, note: "null if no CY2024 base" },
    load_factor: { sources: ["bts_t100_current"], formula: "SUM(PASSENGERS) / SUM(SEATS)", filter: t100Filter, note: `seat fill on departing segments (not BTS passenger-miles LoadFactor); null under ${MIN_DEPARTURES_FOR_RATIOS} departures` },
    haul_mix: { sources: ["bts_t100_current"], formula: `share of DEPARTURES_PERFORMED by DISTANCE: short <${HAUL_SHORT_MAX_MILES} mi, long >${HAUL_LONG_MIN_MILES} mi, medium between`, filter: t100Filter, note: "includes international segments" },
    avg_dep_delay_min: { sources: ["bts_ontime"], formula: "AVG(DepDelayMinutes) over non-cancelled departures with a delay value", note: ontimeNote },
    delayed_share: { sources: ["bts_ontime"], formula: "SUM(DepDel15=1) / non-cancelled departures with a delay value", note: ontimeNote },
    cancel_rate: { sources: ["bts_ontime"], formula: "SUM(Cancelled=1) / all scheduled departures", note: ontimeNote },
    "name,city,state,lat,lon,icao": { sources: ["ourairports_airports"], formula: "OurAirports airports.csv, matched on iata_code, iso_country=US" },
    runways: { sources: ["ourairports_runways"], formula: "count of runways with closed<>1, excluding helipads (le_ident H*)", note: "runways_legacy_count keeps the old all-rows count for comparison" },
    "bts_city_market_id,bts_city_name": { sources: ["bts_t100_current"], formula: "ORIGIN_CITY_MARKET_ID, ORIGIN_CITY_NAME as reported by BTS" },
    "cbsa_*,csa_*,county_*": { sources: ["census_geocoder"], formula: "point-in-polygon of airport lat/lon: Metropolitan (else Micropolitan) Statistical Area, Combined Statistical Area, County; null where the point is outside that layer" },
  };
}

async function main() {
  const started = Date.now();
  const guaranteed = GUARANTEED_IATAS;

  const t100CurrentPath = await resolveT100Zip(CURRENT_YEAR);
  const t100PreviousPath = await resolveT100Zip(PREVIOUS_YEAR);
  await fetchOntimeYear(CURRENT_YEAR);
  const ontimePaths = Array.from({ length: 12 }, (_, i) => ontimeCachePath(CURRENT_YEAR, i + 1));
  const referencePaths = await fetchOurAirports();
  await fetchPlaceSources();

  console.log("Aggregating T-100...");
  const t100Current = await aggregateT100Zip(t100CurrentPath);
  const t100Previous = await aggregateT100Zip(t100PreviousPath);
  console.log("Aggregating On-Time (streaming 12 months)...");
  const ontime = await aggregateOntimeZips(ontimePaths);
  const reference = await loadReference(referencePaths);

  const passengers = new Map([...t100Current.airports].map(([iata, t]) => [iata, t.passengers]));
  const coverage = selectCoverage(passengers, guaranteed, TOP_AIRPORT_COUNT);
  const selectedSet = new Set(coverage.selected);
  console.log(`Coverage: ${coverage.selected.length} airports = ${(coverage.coveredShare * 100).toFixed(2)}% of national T-100 enplanements`);

  const geoInputs = coverage.selected.map((iata) => {
    const ref = reference.airports.get(iata);
    if (!ref) fail(`${iata} has no OurAirports record`);
    return { iata, lat: ref.lat, lon: ref.lon };
  });
  const geography = await geocodeAirports(geoInputs);
  const ctx = { t100Current, t100Previous, ontime, reference, geography };
  const airports = coverage.selected.map((iata) => buildAirportRecord(iata, ctx));
  const routeRows = buildRoutes(new Map([[CURRENT_YEAR, t100Current], [PREVIOUS_YEAR, t100Previous]]), selectedSet);
  const places = await loadPlaces();

  const sources = {
    bts_t100_current: await fileFacts(t100CurrentPath, T100_FORM_URL, { table: "T-100 Segment (All Carriers), FMG", period: `CY${CURRENT_YEAR}`, rows_read: t100Current.rowsRead, rows_used: t100Current.rowsUsed }),
    bts_t100_previous: await fileFacts(t100PreviousPath, T100_FORM_URL, { table: "T-100 Segment (All Carriers), FMG", period: `CY${PREVIOUS_YEAR}`, rows_read: t100Previous.rowsRead, rows_used: t100Previous.rowsUsed }),
    bts_ontime: {
      table: "On-Time Reporting Carrier On-Time Performance", period: `CY${CURRENT_YEAR} (12 monthly files)`, rows_read: ontime.rowsRead,
      files: await Promise.all(ontimePaths.map((p, i) => fileFacts(p, ontimeUrl(CURRENT_YEAR, i + 1)))),
    },
    ourairports_airports: await fileFacts(ourAirportsCachePath("airports.csv"), ourAirportsUrl("airports.csv"), { table: "airports.csv", period: "snapshot at retrieval" }),
    ourairports_runways: await fileFacts(ourAirportsCachePath("runways.csv"), ourAirportsUrl("runways.csv"), { table: "runways.csv", period: "snapshot at retrieval" }),
    census_geocoder: await fileFacts(GEOGRAPHY_CACHE.geocoder, GEOCODER_URL, { table: "Geographies by coordinates (benchmark Public_AR_Current, vintage Current_Current)", period: "current Census boundaries at retrieval" }),
    census_gazetteer_places: await fileFacts(GEOGRAPHY_CACHE.gazetteer, GAZETTEER_PLACES_URL, { table: "2025 Gazetteer, places", period: "2025" }),
    census_place_population: await fileFacts(GEOGRAPHY_CACHE.population, PLACE_POPULATION_URL, { table: "sub-est2025 (SUMLEV 162 places), POPESTIMATE2025", period: "July 1, 2025 estimate" }),
  };

  const generatedAt = new Date().toISOString();
  const manifest = {
    generated_at: generatedAt,
    staging_only: true,
    coverage: { airports: airports.length, top_n: TOP_AIRPORT_COUNT, guaranteed_subset: guaranteed.length, national_enplanements_covered_share: Number(coverage.coveredShare.toFixed(4)), national_total_passengers: coverage.nationalTotal, covered_passengers: coverage.coveredTotal, denominator: "all US-origin scheduled passenger enplanements in T-100 (incl. territories and international departures)" },
    thresholds: { min_departures_for_t100_ratios: MIN_DEPARTURES_FOR_RATIOS, min_scheduled_departures_for_ontime: MIN_SCHEDULED_DEPARTURES, haul_short_max_miles: HAUL_SHORT_MAX_MILES, haul_long_min_miles: HAUL_LONG_MIN_MILES, min_place_population: MIN_PLACE_POPULATION },
    sources,
    fields: fieldProvenance(),
    not_sourced: ["Delay causes and taxi-out time are available in On-Time but not aggregated in this pass."],
  };

  const header = { generated_at: generatedAt, provenance: "provenance.next.json" };
  await mkdir(STAGING_DIR, { recursive: true });
  await writeFile(`${STAGING_DIR}/airports.next.json`, JSON.stringify({ meta: { ...header, year: CURRENT_YEAR }, airports }, null, 1) + "\n");
  await writeFile(`${STAGING_DIR}/routes.next.json`, JSON.stringify({ meta: { ...header, columns: ["year", "origin", "dest", "carrier", "distance_mi", "seats", "passengers", "departures"] }, rows: routeRows }) + "\n");
  await writeFile(`${STAGING_DIR}/places.next.json`, JSON.stringify({ meta: { ...header, min_population: MIN_PLACE_POPULATION }, places }) + "\n");
  await writeFile(`${STAGING_DIR}/provenance.next.json`, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`Wrote ${airports.length} airports, ${routeRows.length} route rows, ${places.length} places in ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

main().catch((error) => fail(error.stack ?? String(error)));
