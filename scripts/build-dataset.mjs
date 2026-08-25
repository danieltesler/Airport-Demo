// Rebuilds data/airports.json from public data sources.
//
// What it does, and where each number comes from:
//   - Reference (name, city, state, lat/lon, runways)  ->  OurAirports (public CSV)
//   - 2024 passengers and departures per airport        ->  BTS T-100 Domestic via the
//                                                            USDOT NTAD ArcGIS API (real JSON query)
//   - Load factor, delays, cancellations, haul mix, YoY ->  kept from the existing file
//     growth                                                as documented estimates (no free
//                                                            public API exposes these per airport)
//
// The app reads the file this produces; it does not call these sources at request
// time. Run it with:  npm run build:data
//
// Node 18+ (uses global fetch). If a source is unreachable, that layer is skipped and
// the existing values are kept, so the app always has a working dataset.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DATA_FILE = fileURLToPath(new URL("../data/airports.json", import.meta.url));

const OURAIRPORTS_AIRPORTS = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OURAIRPORTS_RUNWAYS = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const BTS_T100 =
  "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/" +
  "T100_Domestic_Market_and_Segment_Data/FeatureServer/1/query";

/** Parse one CSV line, honoring double-quoted fields that may contain commas. */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, i) => (row[key] = cells[i]));
    return row;
  });
}

async function fetchOurAirports(wantedIatas) {
  console.log("Fetching OurAirports reference…");
  const [airportsText, runwaysText] = await Promise.all([
    fetch(OURAIRPORTS_AIRPORTS).then((r) => r.text()),
    fetch(OURAIRPORTS_RUNWAYS).then((r) => r.text()),
  ]);

  const wanted = new Set(wantedIatas);
  const airports = parseCsv(airportsText).filter((r) => wanted.has(r.iata_code));

  // Count runways per airport ident (ICAO).
  const runwayCounts = {};
  for (const r of parseCsv(runwaysText)) {
    runwayCounts[r.airport_ident] = (runwayCounts[r.airport_ident] ?? 0) + 1;
  }

  const byIata = {};
  for (const a of airports) {
    byIata[a.iata_code] = {
      icao: a.ident,
      name: a.name,
      city: a.municipality || undefined,
      state: (a.iso_region || "").replace(/^US-/, "") || undefined,
      lat: Number(a.latitude_deg),
      lon: Number(a.longitude_deg),
      runways: runwayCounts[a.ident],
    };
  }
  console.log(`  matched ${Object.keys(byIata).length}/${wantedIatas.length} airports`);
  return byIata;
}

async function fetchBtsTraffic(wantedIatas) {
  console.log("Fetching BTS T-100 (2024 domestic) traffic…");
  const inList = wantedIatas.map((c) => `'${c}'`).join(",");
  const url =
    `${BTS_T100}?where=${encodeURIComponent(`origin IN (${inList})`)}` +
    `&outFields=origin,passengers,departures&f=json&resultRecordCount=2000`;

  const data = await fetch(url).then((r) => r.json());
  const byIata = {};
  for (const f of data.features ?? []) {
    const a = f.attributes;
    byIata[a.origin] = { annual_passengers: a.passengers, annual_departures: a.departures };
  }
  console.log(`  matched ${Object.keys(byIata).length}/${wantedIatas.length} airports`);
  return byIata;
}

async function main() {
  const dataset = JSON.parse(await readFile(DATA_FILE, "utf-8"));
  const iatas = dataset.airports.map((a) => a.iata);

  const [reference, traffic] = await Promise.all([
    fetchOurAirports(iatas).catch((e) => {
      console.warn("  OurAirports skipped:", e.message);
      return {};
    }),
    fetchBtsTraffic(iatas).catch((e) => {
      console.warn("  BTS skipped:", e.message);
      return {};
    }),
  ]);

  let refCount = 0;
  let trafficCount = 0;
  for (const airport of dataset.airports) {
    const ref = reference[airport.iata];
    if (ref) {
      refCount++;
      if (ref.icao) airport.icao = ref.icao;
      if (ref.name) airport.name = ref.name;
      if (ref.city) airport.city = ref.city;
      if (ref.state) airport.state = ref.state;
      if (Number.isFinite(ref.lat)) airport.lat = Number(ref.lat.toFixed(4));
      if (Number.isFinite(ref.lon)) airport.lon = Number(ref.lon.toFixed(4));
      if (ref.runways) airport.runways = ref.runways;
    }
    const t = traffic[airport.iata];
    if (t && t.annual_passengers > 0) {
      trafficCount++;
      airport.annual_passengers = t.annual_passengers;
      airport.annual_departures = t.annual_departures;
    }
  }

  dataset.meta.vintage =
    "BTS T-100 Domestic 2024 (passengers, departures) + OurAirports reference; " +
    "load factor, delays, haul mix and YoY growth are documented estimates";
  dataset.meta.sources = {
    reference: "OurAirports (public domain) — name, state, coordinates, runways",
    traffic:
      "BTS T-100 Domestic 2024 via USDOT NTAD ArcGIS API — annual_passengers " +
      "(domestic enplaned) and annual_departures",
    estimated:
      "load_factor, avg_dep_delay_min, delayed_share, cancel_rate, haul_mix, " +
      "pax_growth_yoy — representative estimates (no free per-airport API)",
  };
  if (dataset.meta.field_units) {
    dataset.meta.field_units.annual_passengers =
      "2024 domestic enplaned passengers (BTS T-100 Domestic)";
    dataset.meta.field_units.annual_departures =
      "2024 domestic departures performed (BTS T-100 Domestic)";
  }

  await writeFile(DATA_FILE, JSON.stringify(dataset, null, 2) + "\n", "utf-8");
  console.log(
    `\nWrote ${dataset.airports.length} airports: ` +
      `${refCount} enriched from OurAirports, ${trafficCount} with real 2024 BTS traffic.`,
  );
}

main().catch((e) => {
  console.error("build-dataset failed:", e);
  process.exit(1);
});
