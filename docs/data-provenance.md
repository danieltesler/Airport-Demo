# Where every number comes from

**In one sentence:** every number the agent states comes from an official U.S. government
source or an open public dataset. Some are fetched live at the moment you ask; the rest are
downloaded from the same official sources by a reproducible pipeline and stamped with their
period. Nothing is hand-typed, and the scores are a transparent formula applied on top.

There are three kinds of figure: **live** (queried when you ask), **build-time** (downloaded,
checksummed and aggregated by the pipeline, then bundled), and **modelled** (the scores, which
are a formula over build-time figures, not data).

## 1. Build-time data: the numbers behind the scores

Built by `npm run build:data:staging` and promoted by `npm run promote:data`. Each source
download's URL, retrieval time and SHA-256 is recorded, and every field's formula is stored
in the `meta` block of `data/airports.json`.

| Figure | Plain meaning | Source | Period | How it is computed |
|---|---|---|---|---|
| Annual passengers | People boarding a scheduled passenger flight at the airport | BTS T-100 Segment (All Carriers) | 2025 | Sum of passengers by origin airport; domestic and international, U.S. and foreign carriers |
| International share | Part of those passengers flying to a foreign destination | BTS T-100 Segment | 2025 | 1 − passengers to U.S. destinations / all passengers (U.S. territories count as U.S.) |
| Annual departures | Scheduled passenger flights that departed | BTS T-100 Segment | 2025 | Sum of departures performed by origin airport |
| Passenger growth | Change against the year before | BTS T-100 Segment | 2025 vs 2024 | passengers 2025 / passengers 2024 − 1 |
| Load factor | How full the departing flights were | BTS T-100 Segment | 2025 | passengers / seats on departing flights |
| Haul mix | Short / medium / long flights | BTS T-100 Segment | 2025 | Share of departures by flight distance: under 1,100 mi, 1,100–2,200 mi, over 2,200 mi |
| Average departure delay | Minutes late, on average, leaving the gate | BTS On-Time Reporting Carrier | 2025 (12 monthly files) | Mean delay of non-cancelled departures; early departures count as 0 |
| Share delayed 15 minutes or more | Part of flights that left 15 minutes or more late | BTS On-Time Reporting Carrier | 2025 | Delayed-15 flights / non-cancelled departures |
| Cancellation rate | Part of scheduled flights cancelled | BTS On-Time Reporting Carrier | 2025 | Cancelled / all scheduled departures |
| Name, city, coordinates, open runways | The airport's identity and layout | OurAirports (public domain) | snapshot at retrieval | Matched on IATA code; runways counted if open and not helipads |
| Metro area | The Census metropolitan area that contains the airport | U.S. Census Geocoder | current boundaries | Point-in-polygon on the airport's coordinates |
| Place names for "near <city>" | City names and centres people can search by | U.S. Census Gazetteer + 2025 population estimates | 2025 | Every place of 10,000+ people |
| Route table | Who flies where, by carrier | BTS T-100 Segment | 2024 and 2025 | Passengers, seats, departures per origin, destination and carrier; scheduled passenger service (service class F, freight-configured aircraft excluded) |
| Carrier names | Airline name for each BTS carrier code | BTS carrier lookup table (L_UNIQUE_CARRIERS) | retrieved 2026-10-18 | Code to description, shortened for display; codes not in the table stay as raw codes |

Things to know about these definitions:

- **Scheduled passenger service only.** Cargo flights, charters and freight-configured
  aircraft are excluded.
- **Delays cover the reporting carriers only**: the large U.S. airlines and the regional
  partners that report through them, on domestic flights. Foreign airlines are not in the
  On-Time data, so a gateway's delay figure describes its domestic operation.
- **Thin data is suppressed, not guessed.** A rate built on fewer than 5,000 scheduled
  departures (On-Time) or 365 departures (T-100) is left empty, and any score that needs it
  is shown as "insufficient data". All 102 covered airports clear both thresholds in 2025.
- **Route figures are segments.** Passengers are enplaned passengers per segment, so a connecting
  trip counts once on each segment; a route's figure is not the number of people travelling between
  two cities. Distance is great-circle. Only the 102 covered airports are origins, while a
  destination can be any airport. 2025 is the latest complete year.
- **Carrier names are a lookup, not data.** The route table holds only BTS carrier codes. The names
  come from the BTS carrier lookup table (https://www.transtats.bts.gov/Download_Lookup.asp?Y11x72=Y_haVdhR_PNeeVRef),
  kept as `data/carriers.json` for the 76 carriers that carry 99% of 2025 seats, each with the
  lookup's description verbatim next to the display name. A code that is not in the file is shown as
  the raw code; a name is never guessed. BTS reports the operating carrier, so regional airlines
  (SkyWest, Republic, Envoy, Endeavor, PSA, Horizon, Mesa, Piedmont, GoJet, CommuteAir, Jazz, Air
  Wisconsin) are labelled "operating carrier": the name on the ticket may be another airline's.
- **"No nonstop service in this data" is a fact; "underserved" is an inference.** The first says
  there is no T-100 scheduled segment from a covered airport to that place. The second would also
  need connecting itineraries, fares, nearby airports and demand, none of which are in this data.
  The agent states the fact and does not call a market underserved.
- **A route trend shows what changed, not why.** Comparing 2024 with 2025 names the carriers and
  routes whose seats rose or fell; the reasons are not in the data.
- **Coverage:** the 100 busiest U.S. airports by 2025 enplanements plus Burlington (BTV)
  and Manchester (MHT): 102 airports, 93.9% of U.S. scheduled enplanements.

## 2. Live data: questions about right now

The agent calls these as tools only when a question needs them. Each answer carries the
source name, retrieval time and a limitations note. If a source is down the agent says so and
never falls back to a guess. Live figures never feed the scores.

| Question type | Source | What comes back |
|---|---|---|
| "Any delays or ground stops at JFK right now?" | FAA National Airspace System Status feed | Active ground stop, ground delay program, delay with reason, closure. Cached 60 s. |
| "What is the weather at SEA?" | NOAA Aviation Weather Center (METAR and TAF) | Wind, visibility, ceiling, flight category now, worst category in the forecast. Cached 2–5 min. |
| "How many passengers did BOS handle recently, and is it growing?" | BTS T-100 airport-by-month summary on the data.bts.gov open-data API | Trailing-12-month enplanements, departures, seats, load factor, and growth against the prior 12 months, computed from the monthly rows. |
| "How many runways does ORD have, and how long are they?" | FAA airport master record via USDOT NTAD | Runway count and lengths, tower type, Part 139 class. |
| "How big is the market around DEN?" | U.S. Census Bureau (Geocoder for the metro area, ACS 1-year for population and income) | Metro population, year-over-year growth, median household income. Needs a free Census API key. |
| "How many aircraft are overhead now?" | adsb.lol community ADS-B feed | Aircraft within about 30 nautical miles. |

Why some BTS data is live and some is build-time: BTS publishes the raw T-100 segment
tables and the On-Time tables as bulk monthly files (millions of rows), so route-level and
delay figures are a build-time job. BTS also publishes a small airport-by-month summary of
T-100 on its open-data API, which can be filtered per airport at question time; that is what
the live traffic tool uses. A live traffic figure (latest 12 months) can therefore differ from
the dataset's calendar-year 2025 figure; the agent states each figure's own period.

## 3. Modelled: the scores

Congestion, unmet demand and expansion are not data. They are a documented weighted formula
applied to the build-time figures above. Each input is scaled between its 5th and 95th
percentile across the covered airports, and the weights are shown in the app's "How was this
scored?" panel and in the design document. Say "model", not "measurement".

Not available from any free official source, and so never stated as fact: true unmet demand
(searches or bookings that never happened), airline-level fares, terminal or gate capacity.

## Honest limits to volunteer before being asked

- BTS data lags real time by several months. The scores use calendar year 2025; the live
  traffic tool prints the months it covers.
- Growth is a single year, and 2025 was soft: 53 of the 102 airports carried fewer passengers
  than in 2024. Every month is present in both years, so the declines are real.
- A smaller airport's departure delays often start at the hubs its flights go to, and scores
  compare airports per flight, so small airports can rank alongside large hubs.
- "No FAA program reported" means no ground stop, ground delay or listed delay in the FAA
  feed. It does not prove there are no delays.
- FAA closure entries are NOTAM text and are often general-aviation only; the tool labels
  them.
- Census figures are survey estimates with margins of error, one metro area per airport
  (New York and the Bay Area airports share metro totals).
- The Census Data API needs a free key; without it the metro-population tool reports that it
  is not configured.
- The live hosts were tested from a residential connection, not a cloud datacenter; check the
  live tools after each new deployment.
