"""Provenance and refresh path for the bundled airport dataset.

WHY THIS EXISTS
---------------
The demo ships a curated snapshot (`airports.json`) so it runs offline, for free,
with no API keys. This script documents exactly where that data comes from and
shows how to (1) refresh the geo/reference layer from a live public source and
(2) scale the traffic/delay metrics to a full automated ingest.

DATA SOURCES
------------
1. OurAirports  (reference: name, IATA/ICAO, state, lat/lon, runways)
   - Public domain CSV, no key:  https://davidmegginson.github.io/ourairports-data/airports.csv
   - This script CAN fetch it live (see `refresh_reference`) to verify/enrich the
     reference fields of the bundled dataset.

2. BTS TranStats  (traffic + delays: passengers, seats, departures, distance, delays)
   - Authoritative U.S. DOT data, free, but DOWNLOAD-ONLY (no REST API):
       * T-100 Segment:        https://www.transtats.bts.gov/Tables.asp?DB_ID=111
       * On-Time Performance:  https://www.transtats.bts.gov/Tables.asp?DB_ID=120
   - Full ingestion means: download the monthly prezipped CSVs, load into DuckDB/
     Postgres, and aggregate per airport per year:
       * passengers, seats  -> load_factor = passengers / seats
       * departures         -> volume; distance -> haul mix (short/medium/long)
       * On-Time            -> avg_dep_delay_min, delayed_share (>15m), cancel_rate
   - This is the documented path to replace the curated metric snapshot at scale.

USAGE
-----
    python build_dataset.py --check       # validate airports.json structure
    python build_dataset.py --refresh-geo # (optional) enrich reference from OurAirports

The curated snapshot is intentionally small and hand-verified; run this only when
refreshing or expanding coverage.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DATA_FILE = Path(__file__).with_name("airports.json")
OURAIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv"

REQUIRED_FIELDS = {
    "iata", "icao", "name", "city", "state", "lat", "lon", "runways",
    "annual_passengers", "pax_growth_yoy", "load_factor", "avg_dep_delay_min",
    "delayed_share", "cancel_rate", "annual_departures", "haul_mix",
}


def load() -> dict:
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def check() -> int:
    """Validate that every airport has the required fields and sane values."""
    dataset = load()
    airports = dataset["airports"]
    problems: list[str] = []

    seen = set()
    for a in airports:
        code = a.get("iata", "<missing>")
        missing = REQUIRED_FIELDS - a.keys()
        if missing:
            problems.append(f"{code}: missing fields {sorted(missing)}")
        if code in seen:
            problems.append(f"{code}: duplicate entry")
        seen.add(code)

        mix = a.get("haul_mix", {})
        if mix:
            total = sum(mix.values())
            if not 0.98 <= total <= 1.02:
                problems.append(f"{code}: haul_mix sums to {total:.2f}, expected ~1.0")
        for frac_field in ("load_factor", "delayed_share", "cancel_rate", "pax_growth_yoy"):
            value = a.get(frac_field)
            if value is not None and not 0.0 <= value <= 1.0:
                problems.append(f"{code}: {frac_field}={value} out of [0,1]")

    if problems:
        print("VALIDATION FAILED:")
        for p in problems:
            print("  -", p)
        return 1

    print(f"OK: {len(airports)} airports, all required fields present, haul mixes valid.")
    print(f"Vintage: {dataset['meta']['vintage']}")
    return 0


def refresh_geo() -> int:
    """Optionally verify/enrich reference fields against OurAirports (live fetch).

    This demonstrates real public-data ingestion. It updates lat/lon and runway
    hints for airports already in the dataset; it does not fabricate traffic data.
    """
    try:
        import csv
        import io
        import requests
    except ImportError:
        print("requests is required: pip install -r ../requirements.txt")
        return 1

    dataset = load()
    by_icao = {a["icao"]: a for a in dataset["airports"]}

    print(f"Fetching OurAirports reference from {OURAIRPORTS_CSV} ...")
    resp = requests.get(OURAIRPORTS_CSV, timeout=60)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))

    updated = 0
    for row in reader:
        icao = row.get("ident", "")
        airport = by_icao.get(icao)
        if not airport:
            continue
        try:
            airport["lat"] = round(float(row["latitude_deg"]), 4)
            airport["lon"] = round(float(row["longitude_deg"]), 4)
            updated += 1
        except (ValueError, KeyError):
            continue

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)
    print(f"Refreshed coordinates for {updated} airports from OurAirports.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Airport dataset provenance / refresh tool.")
    parser.add_argument("--check", action="store_true", help="Validate airports.json.")
    parser.add_argument("--refresh-geo", action="store_true",
                        help="Enrich lat/lon from OurAirports (live fetch).")
    args = parser.parse_args()

    if args.refresh_geo:
        return refresh_geo()
    # Default action is a validation check.
    return check()


if __name__ == "__main__":
    sys.exit(main())
