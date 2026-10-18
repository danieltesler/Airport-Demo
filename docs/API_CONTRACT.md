# API Contract — Airport Investment Intelligence Agent

The app is a single Next.js 14 (App Router) application. The chat UI and the API live
in one codebase and one deployment; the browser calls the app's own routes under
`/api` (same-origin, no CORS, no separate backend).

Base URL (local dev): `http://localhost:3000`

| Route | Method | Purpose |
|---|---|---|
| `/api/chat` | POST | One conversational turn (OpenAI tool-calling agent) |
| `/api/stt` | POST | Speech to text (OpenAI Whisper) |
| `/api/tts` | POST | Text to speech: ElevenLabs when configured, OpenAI TTS as the automatic fallback and default |
| `/api/health` | GET | Liveness and dataset vintage |

All routes run on the Node.js runtime and are evaluated per request (never cached).
The app is **English-only**.

---

## `POST /api/chat`

Send a user message plus prior conversation and receive the agent's answer.

### Request body

```json
{
  "message": "Compare LAX and Santa Ana congestion levels.",
  "history": [
    { "role": "user", "content": "Which New England airports are good for expansion?" },
    { "role": "assistant", "content": "Boston (BOS) ranks highest ..." }
  ]
}
```

- `message` — required, non-empty string: the latest user turn.
- `history` — optional array of prior turns, oldest first, each `{ role, content }`
  with `role` of `user` or `assistant`. Turns with any other role or empty content are
  ignored. May be empty or omitted on the first turn.
  - `history[].shown` — optional string, honoured on assistant turns only: the `shown` note
    the server returned with that answer. Replies no longer repeat the table rows, so this
    note is what lets "what about the second one?" resolve. The server treats it as untrusted
    conversation text: newlines and brackets are flattened, it is capped at 800 characters, and
    it reaches the model as `[Shown on screen last turn: ...]` after that turn's content. It is
    never a source of figures: asked for numbers, the model calls a tool again. Omit it and
    nothing changes.

### Input limits

Because every turn costs money, the route bounds its input:

- `message` over 1,000 characters: `413` with `{ "reply": "...", "error": "too_long" }`. A request body declared larger than 100 KB is refused the same way before it is read.
- `history` that is not an array is treated as empty (no error). Otherwise only turns with role `user` or `assistant` and string content are kept, content is cut to 2,000 characters, and only the last 12 turns are used.
- A request the browser marks as coming from another site (`Sec-Fetch-Site` present and not `same-origin`) is refused with `403` and `error: "forbidden"`. A request without the header (a non-browser client) is allowed; this stops other websites from driving a visitor's browser into spending credits, not a script.
- A failed turn returns the fixed code `agent_error`; only the error's name is logged, never its text.
- The route stops after 30 seconds (`maxDuration`).

### Checks the code runs on the model's behalf

A model can ignore or bypass a prompt rule, so these are enforced in code:

- **The user's message reaches the tools.** The server adds the user's own message to each tool call (`user_message`). Tools read "top 3", "5 best" and "least / lowest / fewest" from it, and those win over the model's `top_n` and `order`; a caption states the count and "lowest first".
- **Named airports win.** For `compare_airports`, when the user's words name specific airports ("LAX and Santa Ana", "Portland Oregon and Seattle", "Portland, OR and Seattle"; full state names, postal codes and spelled-out codes such as "L A X" are read) exactly those are compared, even if the model passed other codes or an improvised scope; the notes say the user's words were used. A city with several airports (Dallas: DAL and DFW; New York) returns `ambiguous` even if the model already picked one.
- **Airlines the user names are never dropped.** The code reads airline names (not two-letter codes) from the user's message: one airline filters `capacity_trend` and `route_search` to that airline even if the model forgot the argument, several named together ("Southwest, Spirit, Delta") give ONE combined table by airline, and the airline named in the message beats a different one the model passed. A result with no airline filter says `carriers_included: "all airlines combined"`, and its caption and totals label say so; with a filter, `totals_note` says the totals cover only those airlines, not the airport.
- **Calendar-year questions use calendar-year figures.** "In 2025", "2025 vs 2024" and "last year" are answered from the dataset's calendar-year profile; if the model asks the live BTS summary (a trailing 12 months) for such a question, the server answers with `airport_profile` and marks the result `substituted_for`. A reply that labels live trailing figures as a year is retried once.
- **Clarifying questions are answered in context.** After an `ambiguous` result that offered airports (Dallas: DAL or DFW), a reply such as "DFW please", "use DFW" or "Love Field" is joined to the question it answers (using the `shown` note of the previous turn), so the tools read the rebuilt request. A bare "Dallas and Austin" asks even if the model had already picked an airport.
- **Filters are stated.** `capacity_trend` and `route_search` take an optional `carrier` (name or BTS code). Every result lists `filters_applied` and the totals are labelled with their scope ("Southwest Airlines (WN), all destinations from OAK"), so a carrier's own figures are never presented as the airport's.
- **The written reply is checked against the tool results.** Figures (with digits) that match nothing in this turn's results, causal wording ("driven by", "due to") after a "why" or a capacity answer, and a refusal ("not currently reported") of a question about a named airport's figures that used no dataset tool each trigger ONE corrective model retry that lists the problem. If a figure or a causal phrase survives the retry, the reply is replaced by one written by code from the tool results (the airport facts sentence or the capacity headline, plus "The data shows what changed, not why" when it was causal), or by a short safe line when the results hold nothing to quote; sentences are never patched out, so no dangling fragment ships. The documented constants (the 15-minute delay threshold, the 100 busiest airports, the 93.9% coverage, the data-quality minimums, the haul distances) and sensible roundings of grounded values ("5.3 million" for 5,290,031) are accepted. The check reuses the spoken-line guard's number grounding.
- **Exact counts.** The dataset stores each airport's exact international passengers and prior-year passengers (`international_passengers`, `previous_year_passengers`), and `airport_profile` quotes them with `passengers_prior_year`; nothing is derived from a rounded share or growth.
- **Spoken lines say names, not codes.** In the voice line the server replaces airport codes by the airport's city ("Los Angeles's", not "LAX's") unless two airports in the line share a city, and the guard also accepts the airports' full names for the airports in the answer.
- **Off-topic requests** (a poem, a joke, a recipe, with nothing about airports) are answered by a fixed friendly line without calling the model.
- **Dataset facts** (airport count, share of national traffic, period, sources, refresh) are generated from the data's own metadata into the system prompt, so a coverage answer is not from memory.

### How a turn is processed

The agent calls OpenAI (`gpt-4o-mini` by default) with tool calling enabled and loops:
the model may call tools, the server runs them and returns the results to the model,
and this repeats until the model answers in text or the step cap is reached
(`MAX_AGENT_STEPS`, default 4). Every number comes from the tools and the
deterministic scoring engine behind them; the structured table, assumptions, and
uncertainty text are collected from the tool outputs, not written by the model.

Tools available to the model:

| Tool | Arguments | Returns |
|---|---|---|
| `rank_airports` | `metric` (`expansion` \| `congestion` \| `unmet_demand`), `scope` (optional), `order` (`desc` default | `asc` for least / lowest), `top_n` (default 5, at most 25; a non-number falls back to 5) | `ranking` table; the result carries `order` and `ranked_first_means`, and an `asc` caption ends `lowest first` |
| `compare_airports` | `iatas` (array), or `scope` / `user_words`: when the words name specific airports ("LAX and SNA", "JFK vs EWR", "Los Angeles and Santa Ana") exactly those are compared; when they name an area the busiest 8 airports in it are compared. `metric` (default `congestion`) | `comparison` table, highest score first (insufficient data last); the caption says how the airports were read, e.g. `Comparing 2 airports: LAX, SNA` or `Comparing 3 airports in San Francisco Bay Area (metro area)`. A city name is matched against the airport's city (and its components, so `Dallas` is found in `Dallas-Fort Worth`); one that matches several airports (`New York`, `Dallas`) returns `ambiguous` with the airport options instead of choosing, `Portland, OR` reads `OR` as Oregon, and when a city name picked the airports the note lists airports of the same metro area that were not compared (`Washington` is DCA; IAD is not included). |
| `long_haul_breakdown` | `iata` | `breakdown` table |
| `unmet_demand` | `iata` | `metric` table of score drivers |
| `airport_profile` | `iata` | Full metrics and all three scores (no table) |
| `route_search` | `origin`, `year` (2024 \| 2025), `sort_by` (`passengers` \| `seats` \| `departures`), `top_n` (default 10, max 25), optional `destination` / `destination_words`, optional `carrier` | `metric` table: top routes with carriers, passengers, seats, departures, distance and change from 2024 |
| `carrier_share` | `origin`, `year`, `top_n` (default 8, max 15), optional `destination` / `destination_words` | `metric` table: seat and departure share by carrier, with an `Other` row |
| `capacity_trend` | `origin`, optional `destination` / `destination_words`, optional `carrier`, `group_by` (`destination` \| `carrier`), `top_n` (default 5, max 10) | `metric` table: 2024 vs 2025 seats and passengers, with the biggest increases and cuts |
| `airport_search` | `scope` + `user_words`, `top_n` (default 10, max 25) | `metric` table: dataset airports for a place, with state, metro area and 2025 passengers |
| `live_flights` | `iata` | `metric` table of live aircraft counts (adsb.lol, ~30 nm radius) |
| `faa_airport_status` | `iata` | `metric` table: active FAA ground stop, ground delay program, delay or closure (FAA NAS Status feed) |
| `airport_weather` | `iata` | `metric` table: current METAR and TAF summary (NOAA Aviation Weather Center) |
| `bts_airport_traffic` | `iata` | `metric` table: trailing-12-month enplanements, departures, seats, load factor, growth (BTS T-100, queried live) |
| `faa_airport_infrastructure` | `iata` | `metric` table: runway count and lengths, tower type, Part 139 class (FAA record via USDOT NTAD) |
| `metro_population` | `iata` | `metric` table: metro population, growth, median household income (Census Bureau; needs `CENSUS_API_KEY`) |

#### Route tools

The four route tools read the BTS T-100 route table (2024 and 2025; origin x destination x carrier; code in `lib/routeTools.ts`), so questions about where an airport flies, who flies there and how capacity changed are not limited to a fixed list. They follow the same rules as the other tools:

- **Validated input.** `origin` must be a three-letter code of one of the dataset's 102 airports; `year` must be 2024 or 2025; `sort_by`, `group_by` and counts are checked against fixed sets and caps. A `destination` is an airport code that is a covered airport or appears as a destination in the route table; `destination_words` (the user's own words, passed verbatim) is resolved by the scope resolver below, to covered airports only. Nothing the model writes is placed in a URL, path or query, and the tools make no network calls.
- **Small results.** The model receives aggregated rows only, never raw route rows: at most 25 routes, 15 carriers, 10 increases and 10 cuts, or 25 airports, each with `row_count` (the full count), `returned` and a `truncated` flag. A request above the cap is capped and a note says so.
- **Code-owned text.** The `caption`, `assumptions` and `uncertainty` come from code. The assumptions state that T-100 passengers are enplaned passengers per segment (a connecting trip counts on each segment), seats and departures are those performed, distance is great-circle, 2025 is the latest complete year, and only the 102 covered airports are origins.
- **Facts versus inference.** "No nonstop service in this data" is returned as `no_service` and is a fact about T-100 scheduled segments from the covered airports. Every route result's uncertainty says that calling a market "underserved" is an inference the data cannot support (connecting itineraries, fares, nearby airports and charter service are not in it). `capacity_trend` adds that it shows what changed, not why.
- **Carrier names.** The data holds BTS carrier codes only. Names come from the BTS carrier lookup table (`data/carriers.json`, source stated in its `meta`); a code not in that table is shown as the raw code. Regional airlines (SkyWest, Republic, Envoy, Endeavor, PSA, Horizon, Mesa, Piedmont, GoJet, CommuteAir, Jazz, Air Wisconsin) are marked `operating_carrier: true` and labelled "operating carrier", because BTS reports the operating airline while the ticket may carry another airline's brand.
- **Same scope behaviour.** `airport_search` and the destination filters use the scope rules below: the user's words win over the model's `scope`, and ambiguous, unknown or empty places return the same error shapes (options, suggestions, `coverage`) instead of a table. With no scope passed, unrecognized words stay unrecognized rather than meaning "all airports".

Example result (abridged) for `capacity_trend` with `{"origin": "OAK", "group_by": "carrier", "top_n": 3}`:

```json
{
  "origin": "OAK",
  "years": { "prior": 2024, "current": 2025 },
  "group_by": "carrier",
  "totals": { "seats_prior": 7034708, "seats_current": 6137508, "seats_change": -897200, "seats_change_pct": -12.8,
              "passengers_prior": 5290031, "passengers_current": 4501620, "passengers_change": -788411, "passengers_change_pct": -14.9 },
  "row_count": 14,
  "returned": 6,
  "truncated": true,
  "biggest_cuts": [
    { "key": "WN", "label": "Southwest Airlines (WN)", "operating_carrier": false, "seats_prior": 5511216, "seats_current": 4800473, "seats_change": -710743, "seats_change_pct": -12.9 },
    { "key": "NK", "label": "Spirit Airlines (NK)", "seats_change": -303858, "seats_change_pct": -60.1 }
  ]
}
```

and the table the UI renders for it (`structured`, kind `metric`):

```json
{
  "kind": "metric",
  "columns": ["Change", "Carrier", "Seats 2024", "Seats 2025", "Seat change", "Seat change (%)", "Passengers 2024", "Passengers 2025", "Passenger change (%)"],
  "rows": [
    ["Total", "all destinations from OAK", 7034708, 6137508, -897200, "-12.8%", 5290031, 4501620, "-14.9%"],
    ["Cut", "Southwest Airlines (WN)", 5511216, 4800473, -710743, "-12.9%", 4091279, 3500130, "-14.4%"]
  ],
  "caption": "Capacity trend, flights from OAK · 2024 to 2025 · biggest changes by carrier"
}
```

`route_search` returns `routes[]` (rank, destination, carriers, passengers, seats, departures, distance_mi, yoy_pct), `carrier_share` returns `carriers[]` plus an `other` bucket whose share is what is left of 100%: the shares of every row, Other included, are rounded together (largest remainder), so each column adds up to exactly 100.0 and none is negative, and `airport_search` returns `airports[]` (iata, name, city, state, metro_area, passengers).

#### Live-data tools

The last five tools query public APIs at question time (code in `lib/live/`). They take only an IATA code, validated against the dataset's airport list; nothing the model writes is placed in a URL. Every result carries `source`, `retrieved_at` and a limitations note, and on failure returns `available: false` with a short message and a `fallback` instruction (say the live source is unavailable, use the dataset figure labelled as a snapshot, never invent a value).

- **Scores never use live values.** Rankings, comparisons, profiles and all three scores are computed from the bundled dataset only, so they are reproducible. A live tool answers a live question and may show a more recent figure than the dataset; `bts_airport_traffic` then adds a `bundled_dataset` block with the dataset's figure, its vintage and a `differs_materially` flag so the two are presented with their own periods.
- **Tables.** A live tool's `metric` table is returned as `structured` only when no analysis table (ranking, comparison, breakdown) was produced earlier in the same turn; it never replaces one. Failed live calls add no table. The `retrieved_at` in a live result is the time the data was actually fetched: a figure served from the tool's short cache keeps its original fetch time (the oldest, when several cached values were combined). Every live table carries a code-built `caption` such as `Source: FAA NAS Status · retrieved 14:32 UTC`, using the tool's own retrieval time; like all captions it is never sent to the model. Load factor in every table (comparison, ranking, live BTS traffic) is a percentage with one decimal, for example `79.9%`; the model's tool result carries the same figure as `load_factor_pct`.
- **Population without a key.** The dataset has no population field. When `metro_population` cannot answer (no `CENSUS_API_KEY`, no metro area, no published estimate) its result is `available: false` with `do_not_estimate: true` and a fallback telling the model to say so plainly and give no number from memory. Every unavailable live result carries `do_not_estimate: true`.
- **Source facts.** The FAA NAS Status feed lists only airports with an active program, so "none reported" is not "no delays". BTS T-100 lags real time by several months and the result states the latest month covered. FAA closure entries are NOTAM text and can be general-aviation only. Census figures are survey estimates, one metro area per airport. The hosts have not yet been tested from a Vercel datacenter IP.

#### Scope resolution

The model passes the user's place words verbatim (never translated or narrowed: "northeast" stays "northeast") in `scope`, and also copies them into `user_words`; when both are present the code resolves `user_words` and prefers it, adding a note if the passed `scope` disagreed.  **code** resolves it
(`lib/geography.ts`) and the model never decides which airports belong to an area.
Resolution order is deterministic:

| Scope text | Resolved as | Membership rule |
|---|---|---|
| empty, `all` | `all` | every airport in the dataset |
| an airport code in the dataset | `airport` | that airport |
| a named metro alias (`LA`, `Bay Area`, `NYC`, `DC`, ...) | `metro` | alias row in `data/geography.json`: center + radius |
| a Census metro area: CBSA title (`Boston-Cambridge-Newton, MA-NH`), title without states, `<principal city> metro`, or CBSA code (`14460`) | `metro` | the CBSA that contains each airport (Census Geocoder); two CBSAs matching the same words are `ambiguous` |
| `near <city or airport>`, `within N miles/km of <city or airport>` | `radius` | great-circle distance to each airport's lat/lon (default 50 mi, max 1000); city coordinates from the Census Gazetteer (places of 10,000+ people) or the airports' own cities |
| a U.S. state or territory (name, postal code, or `<name> state`) | `state` | airport's state code |
| a Census division (New England, Pacific, Mountain, ...) | `census_division` | U.S. Census Bureau definition, by state code |
| a Census region (Northeast, Midwest, South, West) | `census_region` | U.S. Census Bureau definition, by state code |
| an informal region (`West Coast`, `East Coast`, `Gulf Coast`, `Pacific Northwest`, `Southwest`, `Southeast`, `Mid-Atlantic`, `Great Lakes`, `Rocky Mountain states`, `Sun Belt`, `Deep South`; also `Pacific Coast`, `Atlantic Coast`) | `informal_region` | an explicit state list kept in `data/geography.json` (`state_set_aliases`), with a one-line definition that is returned in `scope_notes` and shown in the caption, e.g. `Scope: West Coast · informal region (CA, OR, WA) · 15 airports matched · ...` |
| a bare city name | `radius` | same as `near <city>` |

Natural filler is tolerated ("Northeast US", "Texas area", "Northeast including New York"): the leading phrase is used, the resolution is marked `reinterpreted`, the notes say what was ignored, and the caption shows `read from "..."`.

Matching ignores case, whitespace, punctuation, diacritics (`San José`), trailing punctuation (`Texas?`) and a leading "the"; after `near` or `within N miles of`, a trailing `airport` or `area` is dropped when the words as typed are not recognized (`near JFK airport`, `near Boston area`). The scope text read is capped at 200 characters. A named alias
outranks a postal code of the same spelling (`LA` is the Los Angeles metro, not
Louisiana); the result carries a note saying so.

Resolution never returns a silent empty or "everything". Statuses, as returned in the
tool result:

- `matched`: airports found. The result carries `scope_resolved_as`, `scope_label`,
  `airports_matched` and `scope_notes`, plus `requested_top_n` and `airports_returned`. When fewer airports matched than asked for it also carries `count_note` and `dataset_states` so the reply states the real number instead of "top N".
- `empty`: understood, but no dataset airport falls inside (for example a state the
  dataset does not cover, such as Kansas). Notes name the nearest covered airport for radius scopes.
- `ambiguous`: more than one meaning (`Portland` is Oregon, Maine and others; `Washington`
  is the state or DC; a bare `New York` is the state or the New York City area, with the options
  `NY` and `NYC`, so a request such as "compare the New York airports" asks which one rather than
  returning a state table). `NYC` and `New York City` are the city area; `New York state`, `NY`
  and `upstate New York` are the state (`upstate` is not a boundary in the data, so the note says
  every airport in the state is included). `options[]` lists each meaning with a `scope` string that resolves
  unambiguously. Nothing is picked silently, with two documented exceptions: a place name
  shared by several places resolves to the largest when it has at least ten times the
  population of the next (`Dallas` is Texas), and a city shares a state's name only from
  100,000 people up (`Wyoming` is the state, not Wyoming, Michigan).
- `unknown`: the words match nothing. `suggestions[]` lists the closest supported names (by shared words and spelling), and the result carries `suggested_reply`, a plain sentence for the user ("I don't have 'Gulf' as a ready-made area. Did you mean Gulf Coast?"), so the reply never says the words were not recognized.

Informal regions have no official boundary, so each is a stated list of states. Names whose definition is contested (`Southwest`, `Southeast`, `Mid-Atlantic`, `Rocky Mountain states`, `Sun Belt`, `Deep South`) still resolve, and their notes say which states were used and that definitions vary; for example `Mid-Atlantic` includes NY, NJ, PA, DE, MD and DC, while the Census `Middle Atlantic` division is only NY, NJ and PA. A name that means different places (`Portland`, `New York`) is `ambiguous` and asks.

For every non-`matched` status the tool returns an error, no table, and a `coverage`
object (`airport_count`, `states`, `census_divisions`, `metro_aliases`,
`informal_regions`, `supported_scopes`) so the reply can state what the dataset covers.

The ranking caption is code-owned and shows how the scope was resolved, for example
`Scope: New England · Census division · 6 airports matched · top 3 by expansion score`.
It is never sent to the model. Airports outside the bundled dataset are reported as
unknown; the agent does not invent them.

### Response body (200)

```json
{
  "reply": "**Santa Ana (SNA)** is more congested than **LAX** ...",
  "structured": {
    "kind": "comparison",
    "columns": ["Airport", "Congestion score", "Avg delay (min)", "Delayed 15+ min", "Load factor", "Cancel rate"],
    "rows": [
      ["SNA — Santa Ana", 40.2, 15.2, "19%", "79.9%", "1.1%"],
      ["LAX — Los Angeles", 28.6, 13.82, "18%", "82.0%", "0.7%"]
    ],
    "caption": "Comparing 2 airports: LAX, SNA · congestion score",
    "explain": {
      "metricLabel": "Congestion",
      "components": [
        { "label": "Flights delayed 15 min or more", "weight": 0.4375 },
        { "label": "Average departure delay", "weight": 0.375 },
        { "label": "Cancellation rate", "weight": 0.1875 }
      ],
      "rows": [
        {
          "airport": "SNA — Santa Ana",
          "score": 40.2,
          "parts": [
            { "value": 0.436, "points": 19.1 },
            { "value": 0.433, "points": 16.3 },
            { "value": 0.258, "points": 4.8 }
          ]
        }
      ]
    }
  },
  "assumptions": [
    "Congestion is proxied by operational strain: average departure delay, ..."
  ],
  "uncertainty": "Delays are 2025 averages for the large reporting carriers (and their regional partners) on domestic flights. ...",
  "spoken": "Santa Ana's a bit more congested than LAX.",
  "shown": "Table (comparison): \"Comparing 2 airports: LAX, SNA · congestion score\". Rows in order: 1 SNA — Santa Ana; 2 LAX — Los Angeles.",
  "meta": {
    "tools_used": ["compare_airports"],
    "data_vintage": "Calendar year 2025: BTS T-100 Segment (all carriers) and BTS On-Time Reporting Carrier data; ...",
    "spoken_source": "model",
    "timings": {
      "total_ms": 2840, "model_calls": 2, "model_ms": 2610, "tools_ms": 4,
      "hops": [
        { "model_ms": 1310, "tools": [{ "name": "compare_airports", "ms": 4 }] },
        { "model_ms": 1300, "tools": [] }
      ]
    }
  }
}
```

(Values above are from the 2025 data; trimmed with "..." where long.)

- `reply` — **required**, Markdown string. The natural-language answer to render.
- `structured` — on a successful turn, `null` when no table-producing tool ran
  (greetings, capability questions, `airport_profile`, or a tool that returned an error
  such as an unmatched scope). Otherwise `{ kind, columns, rows, caption?, explain? }`
  where `kind` is `ranking` | `comparison` | `breakdown` | `metric` and each cell is a
  string or number. If several tools ran in one turn, the last table produced is returned.
  - `caption` — optional string stating what was asked of the data, for example
    "Scope: new england · 6 airports matched · top 3 by expansion score".
  - `explain` — optional score breakdown, present on `ranking` and `comparison` results
    and shown in the UI under "How was this scored?":
    `{ metricLabel, components: [{ label, weight }], rows: [{ airport, score, parts: [{ value, points }] }] }`.
    `parts` follows the order of `components`; `value` is the normalized 0-1 component
    and `points` is its contribution to the 0-100 score (weight x value x 100). Points are
    rounded together to 1 decimal (largest remainder), so a row's points add up exactly to its
    displayed `score`.
  - `caption` and `explain` are produced by code from the scoring engine and are never
    sent to the model.
- `assumptions` — array of short strings, de-duplicated across tool calls, or `null`.
- `uncertainty` — string (notes joined with a space) or `null`.
- `meta.tools_used` — de-duplicated names of the tools called this turn.
- `meta.data_vintage` — the provenance footer. Dataset-only turns: the dataset vintage string (see Known limitations). Turns that used only live tools: `Live data: <source> · retrieved <date time> UTC` for each source (omitted when every live call failed). Turns that used both: `Dataset: <vintage> | Live data: ...`.
- `spoken` — optional string: the line to read aloud, written by the model and **verified by the server** (every number and place name must trace to this turn's tool results or earlier context). It is omitted whenever it is missing, malformed or rejected; the client then builds its own summary from `structured`. Controlled by `SPOKEN_MODE` (see Configuration).
- `shown` — optional string: a code-built note of what the user sees for this answer (the table caption, the row labels in order, or the options of an ambiguous question; labels only, no metrics). The client may send it back on this assistant turn in `history[].shown`.
- `meta.spoken_source` — `model` (the verified `spoken` line), `template` (no usable model line but a table exists, so the client builds the summary) or `none` (neither; the client reads the start of `reply`).
- `meta.spoken_guard_rejections` — present only when the model wrote a spoken line and it was rejected: the number of checks that failed. A count only, never the rejected text; use it to measure the fallback rate.
- `meta.timings` — `{ total_ms, model_calls, model_ms, tools_ms, hops }`, where each hop is one model call with its duration and the tools it triggered (`{ name, ms }`).
- Reply style: the model is instructed to answer in two to four sentences (about 70 words), lead with the insight, never restate the table rows, and add one caveat only when it changes the conclusion. In `SPOKEN_MODE=model` the final model message is strict JSON `{ reply, spoken }`; if it is not valid JSON the plain text becomes `reply` and there is no `spoken`.
- If the step cap is reached with tool results still unanswered, one final model call with tools switched off writes the answer from what was gathered; only if that also yields no text is `reply` a short "could you rephrase" message. A model reply that is JSON wrapped in a code fence is unwrapped, and text that starts with `{` but cannot be read (for example cut off by the token limit) is never shown: the user sees a short "ask again" line instead.

### Error responses

`reply` is always present so the UI can render something. `error` is a short code for
logs and debugging, not for display.

| Condition | Status | `error` |
|---|---|---|
| `OPENAI_API_KEY` not configured | 200 | `missing_api_key` |
| Body is not valid JSON | 400 | `bad_request` |
| `message` missing, empty, or not a string | 400 | `empty_message` |
| Agent or OpenAI failure | 200 | error name, or `agent_error` |

```json
{ "reply": "I hit an error while analyzing that. Please try again in a moment, or rephrase your question.", "error": "agent_error" }
```

Error responses contain only `reply` and `error`: `structured`, `assumptions`,
`uncertainty`, and `meta` are omitted entirely (not `null`). The `null` values described
above apply only to successful turns.

Edge case: a `history` that is not an array (for example an object or a number) is not
rejected with a 400. It fails while the agent builds the message list, so the client
receives a 200 with the agent-failure reply and an error name such as `TypeError`.
Send `history` as an array or omit it.

---

## `POST /api/stt`

Transcribe recorded audio to English text with OpenAI Whisper (`whisper-1` by default,
overridable with `OPENAI_STT_MODEL`). A short aviation vocabulary hint is sent to
improve accuracy on airport names and codes.

- Request: `multipart/form-data` with an `audio` file field (the browser uploads a
  recording). The filename extension follows the recording's real MIME type
  (`speech.webm`, `speech.mp4` for Safari), because the filename is forwarded to the
  transcription service.
- Response 200: `{ "text": "..." }`
- Limits: audio over 1,000,000 bytes is refused with 413 (the browser stops recording at 20 seconds, which is well under 200 KB of compressed speech), and only `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` and `audio/wav` are accepted (a `;codecs=` suffix is fine); anything else is 415. The same cross-site check as `/api/chat` applies.

| Condition | Status | Body |
|---|---|---|
| `OPENAI_API_KEY` not configured | 503 | `{ "error": "OPENAI_API_KEY not set" }` |
| Audio over 1,000,000 bytes | 413 | `{ "error": "audio too large" }` |
| Audio type not allowed | 415 | `{ "error": "unsupported audio type" }` |
| Unreadable form data | 400 | `{ "error": "bad request" }` |
| Missing or empty `audio` | 400 | `{ "error": "no audio" }` |
| Transcription failed | 502 | `{ "error": "transcription failed" }` |

---

## `/api/tts`

Convert text to natural speech. Two providers, chosen on the server:

- **ElevenLabs** when `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are both set
  (model `eleven_flash_v2_5` unless `ELEVENLABS_MODEL_ID` says otherwise; MP3, 44.1 kHz,
  64 kbps). The clip is generated whole (a sentence is short) and returned buffered.
- **OpenAI TTS** (`gpt-4o-mini-tts`, voice `nova`; `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`)
  when ElevenLabs is not configured, and as the automatic fallback for any single request
  ElevenLabs cannot or should not serve: an error, a 2.5 s timeout, a 401/402/429 (bad key,
  out of credits, busy), the credit guards below, or text over the ElevenLabs cap. After a
  401 or 402 ElevenLabs is skipped for 5 minutes. OpenAI audio is streamed back.

Response headers: `X-TTS-Provider: elevenlabs|openai`, and `X-TTS-Fallback:
too-long|unavailable` when ElevenLabs was configured but OpenAI spoke. No
provider detail, status or key is ever returned. Audio is `audio/mpeg`. Text is truncated to
600 characters (the web app posts one short sentence at a time).

Credit guards (both providers: the OpenAI fallback spends the same budget, so it is never an unlimited path): at most
`ELEVENLABS_MAX_CHARS` (600) per request, `ELEVENLABS_CLIENT_CHARS_PER_HOUR` (3000) per
client (first `x-forwarded-for` address), `ELEVENLABS_CHARS_PER_DAY` (8000) in total, and
`ELEVENLABS_MAX_CONCURRENT` (3) calls in flight (extra calls wait).

The budgets count characters, but ElevenLabs bills credits. Measured on this account: 0.2
credit per character on `eleven_flash_v2_5` and 0.4 on `eleven_multilingual_v2`. On Flash the
defaults are therefore 600 credits per client per hour and 1,600 credits per day (double on
Multilingual); at that daily cap a 30-day month is 48,000 credits, so lower
`ELEVENLABS_CHARS_PER_DAY` if the plan allowance is smaller. **The plan allowance itself is
unverified**: the API key lacks the `user_read` permission, so it could not be read back;
check the dashboard. The browser gives the first clip of an answer 6 s to start responding (the normal ElevenLabs clip takes about 0.7 s, and an OpenAI fallback answers its headers after the 2.5 s ElevenLabs timeout), shows "Preparing voice…" until audio plays, and then reads its body for up to 15 s (an OpenAI fallback clip took 9-12 s to finish when measured). Later clips get 15 s throughout. Past that the chip says voice is off and the answer is on screen. Over the per-client or daily budget the request is refused with `429` (the app shows the text answer); a request that ElevenLabs fails within budget is served by OpenAI on the characters already spent, and fails with 502 only if no provider can speak (the characters are then given back). **These limits live in memory: they reset on restart and each serverless
instance counts separately, and `x-forwarded-for` can be spoofed outside Vercel, which overwrites it with the real client address (a caller who rotates it gets a fresh per-client budget, and 1,001 distinct ids evict the oldest bucket and so reset it), so the per-client limit is a courtesy and **the global daily
cap is the real bound** on spend through this endpoint (per instance).**
They are a speed bump against burning paid credits, not authentication; real auth is the
next step.

- `POST /api/tts` with JSON `{ "text": "..." }` — what the web app uses: one request
  per sentence, so the text never appears in a URL or an access log.
- There is no `GET` form: text in a URL would land in access logs. A cross-site browser request is refused with 403, as on the other routes.

| Condition | Status | Body |
|---|---|---|
| No provider configured (neither key set) | 503 | plain text `no speech provider configured` |
| Invalid JSON (POST) | 400 | plain text `bad request` |
| Per-client or daily character budget spent | 429 | plain text `speech budget used up` |
| Empty `text` | 400 | plain text `empty text` |
| Synthesis failed on every available provider | 502 | plain text `tts failed` |

---

## `GET /api/health`

Returns `{ "status": "ok", "data_vintage": "..." }`. Use it to verify the app is up.
It does not check OpenAI or adsb.lol connectivity.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | OpenAI access for chat and STT, and for TTS as the default and fallback provider |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat model |
| `OPENAI_MAX_TOKENS` | `1500` | Per-completion token cap |
| `MAX_AGENT_STEPS` | `4` | Max model/tool iterations per turn (a non-numeric value falls back to the default) |
| `SPOKEN_MODE` | `model` | `model`: the model also writes a voice line that the server verifies before returning it as `spoken`. `template`: plain-text replies only, no `spoken`; the client builds the voice line from the table. Switch to `template` to turn the model voice line off. |
| `OPENAI_STT_MODEL` | `whisper-1` | Speech-to-text model |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | `nova` | Text-to-speech voice (fallback provider) |
| `ELEVENLABS_API_KEY` | — (optional) | Enables ElevenLabs as the primary speech provider (server-side only; paid plan) |
| `ELEVENLABS_VOICE_ID` | — (optional) | ElevenLabs voice; both this and the key are needed |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` | ElevenLabs model |
| `ELEVENLABS_MAX_CHARS` | `600` | Max characters per ElevenLabs request (longer text goes to OpenAI) |
| `ELEVENLABS_CLIENT_CHARS_PER_HOUR` | `3000` | Per-client character budget per hour |
| `ELEVENLABS_CHARS_PER_DAY` | `8000` | Global character budget per day (per server instance) |
| `ELEVENLABS_MAX_CONCURRENT` | `3` | Simultaneous ElevenLabs calls |
| `NEXT_PUBLIC_API_BASE_URL` | empty | Only if the API is on a different origin than the UI |
| `CENSUS_API_KEY` | — (optional) | Free Census Bureau key; enables `metro_population`. Without it that tool reports it is not configured. Server-side only. |
| `CENSUS_ACS_YEAR` | `2024` | Optional ACS 1-year vintage override |

The live-flights, FAA status, weather, BTS traffic and FAA infrastructure tools use free public APIs and need no key. Only the Census tool needs one (free: https://api.census.gov/data/key_signup.html).

---

## Notes for the frontend

- Always render `reply` as Markdown.
- If `structured` is present, render it as a table; a bar chart is used for
  `ranking`, `comparison`, and `breakdown` where it helps.
- `error` is a short code and is never displayed. The UI uses its presence to render the
  error bubble ("Something went wrong" plus a Try again button).
- If `structured.caption` is present, show it with the table; if `structured.explain` is
  present, offer it under "How was this scored?".
- Always surface `assumptions` and `uncertainty` when present; communicating
  assumptions, uncertainty, and scope is a core goal of the product.
- Voice: record audio in the browser and send it to `/api/stt`; the browser's built-in
  speech APIs are not used. When the response carries a verified `spoken` line the app
  speaks that. Otherwise it speaks "template v2" (`lib/spoken.ts`): one or two short, natural
  sentences built client-side from the same `structured` table (the leader and the next two, one
  rounded figure, the first short sentence of `uncertainty`; no scores or "out of 100"). A table
  shape it cannot summarise sensibly gets no template and the whole short reply is spoken
  instead (cut only between sentences, 600 characters at most). Each sentence is requested with
  `POST /api/tts` (up to four at once) and played in order. Answers to typed questions are
  not spoken unless the user taps "Read aloud".
- Hung requests: the browser stops waiting for `/api/chat` after 45 s and shows a friendly error with "Try again" (`error: "timeout"` is client-side only, never sent by the server). The Stop button cancels the request and returns to idle, in tap-to-talk, typed and Conversation modes alike.
- Voice history: each assistant answer's `shown` note is sent back as `history[].shown`, so
  "what about the second one?" still has a referent now that replies do not restate the rows.
- "One moment": for a spoken question whose answer takes more than 1.5 seconds, the app says one
  of four fixed phrases ("Sure, one moment.", and so on). Once a phrase has started it is always finished, never cut off: the answer's clips are requested straight away and play right after it. They are fetched once per page from
  `/api/tts` on the first mic tap and cached in memory (about 100 characters, so roughly 20
  ElevenLabs Flash credits per page load), so playing one is instant and costs nothing per turn.
- Silent clips are not sent to `/api/stt`: a recording with no detected speech is dropped
  ("I didn't hear anything"), and a transcript that is only filler ("Thank you.", "you") is
  treated as not heard. This stops speech recognition inventing a question from silence.
- Conversation mode (hands-free, client only, no API change): behind
  `NEXT_PUBLIC_CONVERSATION_MODE` (on everywhere unless set to `off` at build time, which hides
  the button). It repeats listen, send, answer, listen on its own. It is half-duplex (the
  microphone is not recorded while the assistant speaks, apart from the barge-in watch below; listening resumes after a 400 ms gap), and has an
  End button whenever it is on. **Voice barge-in** is on by default while a conversation runs: the
  microphone (opened with echo cancellation, noise suppression and auto gain requested) is also
  watched while the assistant is audible, including the "one moment" phrase. If the user speaks
  over it, playback stops, any answer still on its way is dropped, and the new question is
  recorded from its first word (two short rolling recordings run during playback, and the older
  one is adopted, so nothing is lost). To avoid mistaking the assistant's own voice for the user,
  the detector measures the echo that is left at the start of each clip, ignores the first 600 ms,
  and needs speech at least 2.5 times that echo (and at least 0.05 RMS, and voice-like), kept up for
  400 ms: a cough, a click or a burst of echo cannot trigger it. This depends on the browser's echo
  cancellation, which is good on many Chrome Android devices but not guaranteed on all; it can
  fail on a loud speaker. If two barge-ins in a row, or three in a session, turn out to be
  nothing (an empty or filler transcript), it switches itself off for the session and shows one
  short tip about headphones; a tap on the speaking indicator still interrupts, and headphones are
  recommended in noisy or loud setups. There is no on/off control; `?bargein=off` in the address
  (or `localStorage.bargein = "off"`) disables it for debugging. When it is off the behaviour is
  half-duplex as before (the microphone is silent while the assistant speaks). It pauses itself, with a chip message
  and the answer still on screen, after 8 s of silence, 3 empty turns in a row, 10 turns without
  a tap, the page being hidden or the screen locking, audio that cannot resume without a tap
  (iOS), a stopped microphone, or any failed step. It asks for a screen wake lock while active
  (where the browser supports it) and releases it on every pause and on End.

---

## Known limitations

- **No authentication or rate limiting on any `/api` route.** `/api/chat`, `/api/stt`,
  and `/api/tts` each trigger paid calls (OpenAI, and ElevenLabs credits when configured),
  so an open deployment is exposed to cost abuse (denial of wallet). The routes bound their
  input (chat: 1,000-character message, 12 turns of at most 2,000 characters; stt: 1 MB and an
  allow-list of audio types; tts: 600 characters, one character budget per client and one
  global budget shared by both providers) and refuse cross-site browser requests. The budgets
  are in memory: they reset per serverless instance and on restart, and are a speed bump, not
  authentication. The ElevenLabs monthly allowance depends on the plan in use.
- **Conversation history and the `shown` note are not signed.** They come from the client and
  are validated for shape and size only; every figure still comes from a tool call, but a caller
  can put any earlier turns in the history. Real authentication is the next step.
- **Dependencies.** The app runs Next.js 14; most published advisories for it concern features
  this deployment does not use (the image optimizer, middleware). Upgrading is planned.
- **Data definitions.** Scores use calendar-year 2025 BTS data: T-100 Segment (all
  carriers, international included) for passengers, departures, load factor, haul mix and
  growth (2025 vs 2024), and On-Time Reporting Carrier data for delays and cancellations,
  which covers only the large reporting carriers (and their regional partners) on domestic
  flights. Each input is scaled between the 5th and 95th percentile of the 102 airports
  (rounded outward to two significant figures), so a score is relative to large U.S.
  airports. Sources, formulas and checksums per field are in `data/airports.json` `meta`;
  see [data-provenance.md](data-provenance.md).
- **Effective weights**, computed from `lib/scoring.ts` (load factor is not part of
  congestion, so it counts once):

  | Input | Congestion | Unmet demand | Expansion |
  |---|---|---|---|
  | Load-factor pressure | — | 40.0% | 25.0% |
  | Share of departures delayed 15 minutes or more | 43.75% | 15.3125% | 13.125% |
  | Average departure delay | 37.5% | 13.125% | 11.25% |
  | Cancellation rate | 18.75% | 6.5625% | 5.625% |
  | Passenger growth | — | 15.0% | 30.0% |
  | Departures per open runway | — | 10.0% | — |
  | Passenger volume | — | — | 15.0% |

- **Insufficient data.** A rate resting on too few flights (under 5,000 scheduled
  departures in On-Time, under 365 departures in T-100) is null in the data and is never
  defaulted: rankings leave that airport out and list it in `insufficient_data`
  (`[{ iata, missing }]`, with the caption saying "N not scored (insufficient data)"),
  comparisons return `score: null` with an `insufficient_data` reason and show
  "insufficient data" in the table, and single-airport tools return `insufficient_data`
  with no table. All 102 airports clear both thresholds in the 2025 data.
- **Coverage.** 102 airports: the 100 busiest U.S. airports by 2025 enplanements plus
  Burlington (BTV) and Manchester (MHT), 93.9% of U.S. scheduled enplanements.
- **No table on unmatched input.** If a ranking's `scope` is ambiguous, unknown, or matches
  zero airports, the tool returns an error with options or suggestions plus dataset
  coverage, and no structured payload; the same applies to a comparison that names an airport outside the dataset.
  The reply then relies on the model relaying that message, and the turn has no table.
- **Live flights** are a point-in-time count within roughly 30 nm of the airport from a
  community ADS-B feed, and can be unavailable; the agent then reports that plainly.
- **Live public-data tools** (FAA status, weather, BTS traffic, FAA infrastructure, Census)
  can each be unavailable; the agent then says so and falls back to the dataset, labelled as
  a snapshot. See "Live-data tools" above for per-source caveats.

## Next steps

- Authentication and per-client rate limiting and usage caps on all `/api` routes;
  signed conversation history, and a Next.js upgrade (chat, speech and the TTS budgets
  already have size caps).
- An evaluation suite that runs fixed question sets end to end and checks tool choice,
  numbers, and the "no invented airports" rule, to catch regressions when prompts or
  models change.
- Multi-year growth trends from the same BTS pipeline, and FAA ASPM demand-vs-capacity
  data for a stronger congestion signal.
- Fare data (BTS DB1B) so "underserved by demand" can be tested against real fares and
  itineraries, and delay-cause data (BTS On-Time cause fields) to separate weather from
  capacity-driven delay.
- Observability: structured request logs, per-turn tool traces, latency and token/cost
  metrics, and alerting on error rates.
