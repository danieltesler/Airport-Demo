// Promotes the verified staging build (data/staging/*.next.json) into the files the app reads:
//   data/airports.json  airports + provenance meta (source, table, period, retrieved date, formula per field)
//   data/routes.json    origin x destination x carrier rows, read lazily by server-side route tools only
//   data/places.json    Census places gazetteer used to resolve "near <city>"
//
//   npm run promote:data        (runs verify-staging first)
//
// It refuses to promote unless the four staging files come from one build, every source has a URL,
// retrieval time and SHA-256, every cached download still matches its SHA-256, and every airport
// record has the fields the app reads with the right types. Output is a pure function of the
// staging files, so re-running it on the same build rewrites identical files.
import { readFile, rename, writeFile } from "node:fs/promises";
import { ROOT, STAGING_DIR, fail, sha256OfFile } from "./ingest/common.mjs";

const DATA_DIR = `${ROOT}data`;
const failures = [];
const check = (condition, message) => condition || failures.push(message);
/**
 * Write several files so a failure part-way cannot leave a mix of old and new data: every file is
 * first written to a temporary name, and only when all of them are on disk are they renamed into place.
 */
async function writeAll(files) {
  for (const [path, text] of files) await writeFile(`${path}.tmp`, text);
  for (const [path] of files) await rename(`${path}.tmp`, path);
}
const readJson = async (path) => JSON.parse(await readFile(path, "utf-8"));

const NUMBER_FIELDS = ["lat", "lon", "runways", "annual_passengers", "annual_departures", "international_passengers"];
const NULLABLE_NUMBER_FIELDS = ["pax_growth_yoy", "load_factor", "avg_dep_delay_min", "delayed_share", "cancel_rate", "international_passenger_share"];
const STRING_FIELDS = ["iata", "icao", "name", "city", "state"];

function checkSameBuild(staged) {
  const stamps = Object.entries(staged).map(([name, file]) => [name, file.meta?.generated_at ?? file.generated_at]);
  const first = stamps[0][1];
  for (const [name, stamp] of stamps) check(stamp === first, `${name} is from build ${stamp}, expected ${first}`);
}

async function checkSources(manifest) {
  let files = 0;
  for (const [id, source] of Object.entries(manifest.sources)) {
    for (const file of source.files ?? [source]) {
      files++;
      check(Boolean(file.url && file.retrieved_at && file.sha256), `source ${id} lacks url, retrieved_at or sha256`);
      const actual = await sha256OfFile(`${ROOT}${file.file}`).catch(() => null);
      check(actual === file.sha256, `source ${id}: cached download ${file.file} is missing or no longer matches its SHA-256`);
    }
  }
  for (const [field, spec] of Object.entries(manifest.fields)) {
    check(Boolean(spec.formula), `field ${field} has no formula`);
    for (const id of spec.sources) check(Boolean(manifest.sources[id]), `field ${field} cites unknown source ${id}`);
  }
  return files;
}

function checkAirport(airport) {
  const tag = airport.iata ?? "(no iata)";
  for (const field of STRING_FIELDS) check(typeof airport[field] === "string" && airport[field].length > 0, `${tag}.${field} must be a non-empty string`);
  for (const field of NUMBER_FIELDS) check(Number.isFinite(airport[field]), `${tag}.${field} must be a number`);
  for (const field of NULLABLE_NUMBER_FIELDS) check(airport[field] === null || Number.isFinite(airport[field]), `${tag}.${field} must be a number or null`);
  check(airport.haul_mix === null || ["short", "medium", "long"].every((k) => Number.isFinite(airport.haul_mix[k])), `${tag}.haul_mix malformed`);
  check(airport.cbsa_name === null || typeof airport.cbsa_name === "string", `${tag}.cbsa_name must be a string or null`);
}

/** Source facts the app may show: no local cache paths, just what a reader can check. */
function publicSource(source) {
  const { file: _file, files, ...rest } = source;
  return files ? { ...rest, files: files.map(({ file: _f, ...f }) => f) } : rest;
}

function retrievedRange(manifest) {
  const dates = Object.values(manifest.sources)
    .flatMap((s) => (s.files ?? [s]).map((f) => f.retrieved_at.slice(0, 10)))
    .sort();
  return dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} to ${dates.at(-1)}`;
}

function airportsMeta(airportsFile, manifest, stagingHashes) {
  const year = airportsFile.meta.year;
  return {
    vintage:
      `Calendar year ${year}: BTS T-100 Segment (all carriers) and BTS On-Time Reporting Carrier data; ` +
      `OurAirports reference; U.S. Census geography. Retrieved ${retrievedRange(manifest)}.`,
    year,
    generated_at: manifest.generated_at,
    staging_sha256: stagingHashes,
    coverage: manifest.coverage,
    thresholds: manifest.thresholds,
    haul_thresholds_miles: { short_max: manifest.thresholds.haul_short_max_miles, long_min: manifest.thresholds.haul_long_min_miles },
    sources: Object.fromEntries(Object.entries(manifest.sources).map(([id, s]) => [id, publicSource(s)])),
    fields: manifest.fields,
    not_sourced: manifest.not_sourced,
  };
}

function pickSources(manifest, ids) {
  return Object.fromEntries(ids.map((id) => [id, publicSource(manifest.sources[id])]));
}

async function main() {
  const staged = {
    airports: await readJson(`${STAGING_DIR}/airports.next.json`),
    routes: await readJson(`${STAGING_DIR}/routes.next.json`),
    places: await readJson(`${STAGING_DIR}/places.next.json`),
    provenance: await readJson(`${STAGING_DIR}/provenance.next.json`),
  };
  const stagingHashes = {};
  for (const name of ["airports", "routes", "places", "provenance"]) {
    stagingHashes[`${name}.next.json`] = await sha256OfFile(`${STAGING_DIR}/${name}.next.json`);
  }

  checkSameBuild(staged);
  const filesChecked = await checkSources(staged.provenance);
  staged.airports.airports.forEach(checkAirport);
  const iatas = staged.airports.airports.map((a) => a.iata);
  check(new Set(iatas).size === iatas.length, "duplicate IATA codes");
  check(iatas.length === staged.provenance.coverage.airports, "airport count differs from the provenance coverage block");
  if (failures.length > 0) fail(`promotion refused, ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);

  const previous = await readJson(`${DATA_DIR}/airports.json`).catch(() => null);
  const manifest = staged.provenance;
  const routeSources = ["bts_t100_current", "bts_t100_previous"];
  const placeSources = ["census_gazetteer_places", "census_place_population"];

  await writeAll([
    [`${DATA_DIR}/airports.json`, JSON.stringify({ meta: airportsMeta(staged.airports, manifest, stagingHashes), airports: staged.airports.airports }, null, 1) + "\n"],
    [
      `${DATA_DIR}/routes.json`,
      JSON.stringify({
        meta: { generated_at: manifest.generated_at, columns: staged.routes.meta.columns, filter: manifest.fields.annual_passengers.filter, sources: pickSources(manifest, routeSources) },
        rows: staged.routes.rows,
      }) + "\n",
    ],
    [
      `${DATA_DIR}/places.json`,
      JSON.stringify({ meta: { generated_at: manifest.generated_at, min_population: staged.places.meta.min_population, sources: pickSources(manifest, placeSources) }, places: staged.places.places }) + "\n",
    ],
  ]);

  const before = new Set((previous?.airports ?? []).map((a) => a.iata));
  const added = iatas.filter((iata) => !before.has(iata));
  const removed = [...before].filter((iata) => !iatas.includes(iata));
  console.log(`Promoted build ${manifest.generated_at}: ${iatas.length} airports, ${staged.routes.rows.length} route rows, ${staged.places.places.length} places; ${filesChecked} source files checksummed.`);
  console.log(`Airports added: ${added.length} ${added.length > 0 && added.length <= 20 ? added.join(", ") : ""}; removed: ${removed.join(", ") || "none"}.`);
  console.log("Next: npm test. lib/anchors.test.ts fails if this data moved a scoring anchor; re-derive with npm run anchors.");
}

main().catch((error) => fail(error.stack ?? String(error)));
