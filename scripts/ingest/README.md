# Data pipeline

Two steps, deliberately separate so nothing reaches the app unverified:

```bash
npm run build:data:staging   # 1. build + verify + preview  -> data/staging/ (git-ignored)
npm run promote:data         # 2. verify + checksum + write  -> data/airports.json, routes.json, places.json
npm run anchors              # 3. confirm the scoring anchors still match the rule
npm test
```

Run them in this order. `data/staging/` is git-ignored, so on a fresh clone `promote:data`
fails until `npm run build:data:staging` has run; staging also needs
the downloads in the git-ignored `data/.cache/`, which the first staging run fetches. The app
itself reads only the committed `data/*.json`, so a fresh clone runs without either step.

**1. Staging.** `build-staging.mjs` downloads real BTS / OurAirports / Census files into the
git-ignored `data/.cache/`, aggregates them, and writes `data/staging/*.next.json`. It never
touches the files the app reads. Re-running reuses cached downloads (about a minute once
cached) and rewrites the same outputs. `verify-staging.mjs` then checks ranges, uniqueness,
that route passengers add up to airport passengers, that every cached download still matches
its SHA-256, and reconciles passengers with the data the app currently reads (flags gaps over
20%). `before-after.mjs` writes `data/staging/before_after.md`: which airports would be added
or removed, the biggest rank moves under the current scorer, changed fields, and the anchors
the rule would produce from the new data.

Staging outputs: `airports.next.json`, `routes.next.json`, `places.next.json`,
`provenance.next.json` (every source with URL, period, retrieved date, bytes, SHA-256; every
field with its formula and filter), and `before_after.json` / `before_after.md`.

**2. Promotion.** `scripts/promote-data.mjs` refuses to promote unless the four staging files
come from one build, every source has a URL, retrieval time and SHA-256, every cached download
still matches its SHA-256, every field cites a known source and has a formula, and every airport
record has the fields the app reads with the right types (rates may be null, never missing).
It then writes:

- `data/airports.json`: the airport records plus a `meta` block with the vintage, coverage,
  thresholds, every source (URL, table, period, retrieval time, SHA-256; no local paths) and
  every field's formula and filter, and the SHA-256 of the staging files it came from.
- `data/routes.json`: origin x destination x carrier x year rows (2024 and 2025), with the
  T-100 filter and sources. Read lazily by `lib/routes.ts`, server-side only.
- `data/places.json`: Census places of 10,000+ people (name, state, coordinates, population).

Output is a pure function of the staging files, so promoting the same build twice writes
identical files.

**3. Anchors.** The scores scale each input between the 5th and 95th percentile of the
covered airports (rounded outward to two significant figures). The values are constants in
`lib/scoring.ts`; `npm run anchors` (or `npm run anchors -- --staging` before promoting)
prints the values the rule gives for the data and exits non-zero if they differ, and
`lib/anchors.test.ts` enforces the same.

## Coverage

The 100 busiest airports by scheduled passenger enplanements in T-100 for the data year,
plus the 28 airports of the original prototype (`GUARANTEED_IATAS` in `coverage.mjs`; BTV and
MHT fall outside the top 100). For 2025 that is 102 airports and 93.9% of national
enplanements.

## T-100 download: scripted, with a manual fallback

The scripted path drives the BTS "T-100 Segment (All Carriers)" form (table FMG): GET the page for
the ASP.NET hidden fields, POST it with the columns ticked. It worked on 2026-10-18 (about 90 s per
year, 7-9 MB zip). If BTS changes the form the script stops with an error. Then do this once per year:

1. Open https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG
2. Geography: All. Year: the year needed. Period: All Months.
3. Tick exactly: DEPARTURES_PERFORMED, SEATS, PASSENGERS, DISTANCE, UNIQUE_CARRIER, ORIGIN,
   ORIGIN_CITY_MARKET_ID, ORIGIN_CITY_NAME, ORIGIN_COUNTRY, DEST, AIRCRAFT_CONFIG, YEAR, MONTH, CLASS
   (also DEPARTURES_SCHEDULED, FREIGHT, MAIL, DEST_COUNTRY, ORIGIN_STATE_ABR are harmless).
4. Tick "Prezipped File" if offered, click Download.
5. Save the zip as `data/.cache/manual/t100_segment_all_carriers_<year>.zip` (e.g. `..._2025.zip`).
6. Run `npm run build:data:staging`. A file in `manual/` takes precedence over the scripted download
   and its SHA-256 is recorded in the provenance manifest.

## Rules baked in

- Scheduled passenger service = CLASS `F`, excluding AIRCRAFT_CONFIG `2` (freight configuration).
- Passengers, departures, load factor and haul mix include international segments and foreign
  carriers (T-100 Segment, All Carriers). `international_passenger_share` is reported per airport.
- Ratios are `null` (never defaulted) below 365 departures (T-100) or 5,000 scheduled departures
  (On-Time). The app shows a score that needs a null input as "insufficient data".
- Census place names drop the legal suffix ("Boston city" -> "Boston"); consolidated city-county
  governments keep the city part ("Nashville-Davidson metropolitan government (balance)" ->
  "Nashville").
- Run time of a cold build is dominated by the 12 On-Time monthly downloads (about 30 MB each).
