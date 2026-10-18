// Sanity checks on data/staging/*.next.json. Exits non-zero on any failure.
//   node scripts/ingest/verify-staging.mjs
import { readFile } from "node:fs/promises";
import { ROOT, STAGING_DIR, fail, sha256OfFile } from "./common.mjs";

// Staged passengers are reconciled with the data the app currently reads; only large gaps fail.
// Tolerance is reported with the result.
const OLD_VS_NEW_PASSENGER_TOLERANCE = 0.2;
const failures = [];
const check = (condition, message) => condition || failures.push(message);
const readJson = async (path) => JSON.parse(await readFile(path, "utf-8"));

function checkAirportRanges(airport) {
  const tag = airport.iata;
  if (airport.load_factor !== null) check(airport.load_factor >= 0.5 && airport.load_factor <= 1, `${tag} load_factor out of 0.5-1: ${airport.load_factor}`);
  if (airport.haul_mix !== null) {
    const total = airport.haul_mix.short + airport.haul_mix.medium + airport.haul_mix.long;
    check(Math.abs(total - 1) < 0.001, `${tag} haul_mix sums to ${total}`);
  }
  for (const field of ["delayed_share", "cancel_rate"]) {
    if (airport[field] !== null) check(airport[field] >= 0 && airport[field] <= 1, `${tag} ${field} out of 0-1`);
  }
  if (airport.avg_dep_delay_min !== null) check(airport.avg_dep_delay_min >= 0 && airport.avg_dep_delay_min < 120, `${tag} avg delay implausible`);
  if (airport.pax_growth_yoy !== null) check(airport.pax_growth_yoy > -0.6 && airport.pax_growth_yoy < 1.5, `${tag} growth implausible: ${airport.pax_growth_yoy}`);
  check(airport.annual_passengers > 0 && airport.annual_departures > 0, `${tag} non-positive traffic`);
  check(airport.runways >= 1, `${tag} has no open runways`);
  check(Boolean(airport.state) && Number.isFinite(airport.lat) && Number.isFinite(airport.lon), `${tag} missing state or coordinates`);
}

async function checkSources(manifest) {
  const files = [];
  for (const source of Object.values(manifest.sources)) files.push(...(source.files ?? [source]));
  for (const file of files) {
    check(Boolean(file.sha256 && file.url && file.retrieved_at), `provenance incomplete for ${file.file ?? "a source"}`);
    const actual = await sha256OfFile(`${ROOT}${file.file}`).catch(() => null);
    check(actual === file.sha256, `checksum mismatch or missing cache file: ${file.file}`);
  }
  return files.length;
}

/**
 * Compare staged passengers with the data the app currently reads, like for like. A promoted
 * file (meta.year present) uses the same definition, all carriers including international; the
 * original hand-curated file was domestic only, so international passengers are stripped first.
 */
function reconcile(current, newByIata) {
  const sameDefinition = Boolean(current.meta?.year);
  const lines = [];
  for (const old of current.airports) {
    const real = newByIata.get(old.iata);
    check(Boolean(real), `${old.iata} missing from staged airports`);
    if (!real) continue;
    const comparable = sameDefinition ? real.annual_passengers : real.annual_passengers * (1 - real.international_passenger_share);
    const gap = comparable / old.annual_passengers - 1;
    lines.push(`${old.iata} ${(gap * 100).toFixed(1)}%`);
    check(Math.abs(gap) <= OLD_VS_NEW_PASSENGER_TOLERANCE, `${old.iata} passengers differ from old file by ${(gap * 100).toFixed(1)}% (> ${OLD_VS_NEW_PASSENGER_TOLERANCE * 100}%)`);
  }
  return lines;
}

async function main() {
  const staged = await readJson(`${STAGING_DIR}/airports.next.json`);
  const manifest = await readJson(`${STAGING_DIR}/provenance.next.json`);
  const routes = await readJson(`${STAGING_DIR}/routes.next.json`);
  const places = await readJson(`${STAGING_DIR}/places.next.json`);
  const current = await readJson(`${ROOT}data/airports.json`);

  staged.airports.forEach(checkAirportRanges);
  const iatas = staged.airports.map((a) => a.iata);
  check(new Set(iatas).size === iatas.length, "duplicate IATA codes");
  const filesChecked = await checkSources(manifest);
  const gaps = reconcile(current, new Map(staged.airports.map((a) => [a.iata, a])));

  const routedOrigins = new Set(routes.rows.map((r) => r[1]));
  check(iatas.every((iata) => routedOrigins.has(iata)), "some covered airports have no routes");
  const routePassengers = routes.rows.filter((r) => r[0] === staged.meta.year).reduce((sum, r) => sum + r[6], 0);
  const airportPassengers = staged.airports.reduce((sum, a) => sum + a.annual_passengers, 0);
  check(routePassengers === airportPassengers, `route passengers ${routePassengers} != airport passengers ${airportPassengers}`);
  check(places.places.length > 1000 && places.places.every((p) => p.population >= places.meta.min_population), "places file looks wrong");

  const missingGeo = staged.airports.filter((a) => !a.cbsa_code).map((a) => a.iata);
  console.log(`airports ${iatas.length}, route rows ${routes.rows.length}, places ${places.places.length}, files checksummed ${filesChecked}`);
  console.log(`old-vs-new passenger gap (tolerance +/-${OLD_VS_NEW_PASSENGER_TOLERANCE * 100}%): ${gaps.join(", ")}`);
  console.log(`airports with no CBSA (outside any metro/micro area): ${missingGeo.join(", ") || "none"}`);
  console.log(`null counts: ${JSON.stringify(nullCounts(staged.airports))}`);
  if (failures.length > 0) fail(`${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  console.log("verify-staging: OK");
}

function nullCounts(airports) {
  const counts = {};
  for (const airport of airports) for (const [key, value] of Object.entries(airport)) if (value === null) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

main().catch((error) => fail(error.stack ?? String(error)));
