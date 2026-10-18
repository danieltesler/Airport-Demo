# API Contract — Airport Investment Intelligence Agent

The app is a single Next.js 14 (App Router) application. The chat UI and the API live
in one codebase and one deployment; the browser calls the app's own routes under
`/api` (same-origin, no CORS, no separate backend).

Base URL (local dev): `http://localhost:3000`

| Route | Method | Purpose |
|---|---|---|
| `/api/chat` | POST | One conversational turn (OpenAI tool-calling agent) |
| `/api/stt` | POST | Speech to text (OpenAI Whisper) |
| `/api/tts` | GET, POST | Text to speech (OpenAI TTS), streamed audio |
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

### How a turn is processed

The agent calls OpenAI (`gpt-4o-mini` by default) with tool calling enabled and loops:
the model may call tools, the server runs them and returns the results to the model,
and this repeats until the model answers in text or the step cap is reached
(`MAX_AGENT_STEPS`, default 6). Every number comes from the tools and the
deterministic scoring engine behind them; the structured table, assumptions, and
uncertainty text are collected from the tool outputs, not written by the model.

Tools available to the model:

| Tool | Arguments | Returns |
|---|---|---|
| `rank_airports` | `metric` (`expansion` \| `congestion` \| `unmet_demand`), `scope` (optional), `top_n` (default 5) | `ranking` table |
| `compare_airports` | `iatas` (array), `metric` (default `congestion`) | `comparison` table |
| `long_haul_breakdown` | `iata` | `breakdown` table |
| `unmet_demand` | `iata` | `metric` table of score drivers |
| `airport_profile` | `iata` | Full metrics and all three scores (no table) |
| `live_flights` | `iata` | `metric` table of live aircraft counts (adsb.lol, ~30 nm radius) |

`scope` accepts `all`, `new_england`, a U.S. state (name or 2-letter code), or a metro
(`LA`, `Bay Area`, `NYC`, `DC`). Airports outside the bundled dataset are reported as
unknown; the agent does not invent them.

### Response body (200)

```json
{
  "reply": "**LAX** is more congested than **Santa Ana (SNA)** ...",
  "structured": {
    "kind": "comparison",
    "columns": ["Airport", "Congestion score", "Avg delay (min)", "Delayed >15m", "Load factor", "Cancel rate"],
    "rows": [
      ["LAX — Los Angeles", 78.4, 14.2, "24%", 0.86, "1.5%"],
      ["SNA — Santa Ana", 41.0, 8.1, "17%", 0.79, "0.9%"]
    ],
    "caption": "Comparing 2 airports · congestion score",
    "explain": {
      "metricLabel": "Congestion",
      "components": [
        { "label": "Flights delayed >15 min", "weight": 0.35 },
        { "label": "Average departure delay", "weight": 0.3 },
        { "label": "Cancellation rate", "weight": 0.15 },
        { "label": "Load-factor pressure", "weight": 0.2 }
      ],
      "rows": [
        {
          "airport": "LAX — Los Angeles",
          "score": 78.4,
          "parts": [
            { "value": 0.8, "points": 28.0 },
            { "value": 0.9, "points": 27.0 },
            { "value": 0.5, "points": 7.5 },
            { "value": 0.795, "points": 15.9 }
          ]
        }
      ],
      "notes": []
    }
  },
  "assumptions": [
    "Congestion blends delay rates, cancellations and load-factor pressure (see design doc)."
  ],
  "uncertainty": "Annual averages smooth out peak-day congestion.",
  "meta": {
    "tools_used": ["compare_airports"],
    "data_vintage": "BTS T-100 Domestic 2024 ..."
  }
}
```

(Values above are illustrative.)

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
    `{ metricLabel, components: [{ label, weight }], rows: [{ airport, score, parts: [{ value, points }] }], notes: [string] }`.
    `parts` follows the order of `components`; `value` is the normalized 0-1 component
    and `points` is its contribution to the 0-100 score (weight x value x 100). `notes`
    carries code-written caveats, such as load factor also entering through congestion.
  - `caption` and `explain` are produced by code from the scoring engine and are never
    sent to the model.
- `assumptions` — array of short strings, de-duplicated across tool calls, or `null`.
- `uncertainty` — string (notes joined with a space) or `null`.
- `meta.tools_used` — de-duplicated names of the tools called this turn.
- `meta.data_vintage` — the dataset vintage string (see Known limitations).
- If the step cap is reached without any text, `reply` is a short "could you rephrase"
  message.

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
  recording, e.g. `audio.webm`).
- Response 200: `{ "text": "..." }`

| Condition | Status | Body |
|---|---|---|
| `OPENAI_API_KEY` not configured | 503 | `{ "error": "OPENAI_API_KEY not set" }` |
| Unreadable form data | 400 | `{ "error": "bad request" }` |
| Missing or empty `audio` | 400 | `{ "error": "no audio" }` |
| Transcription failed | 502 | `{ "error": "transcription failed" }` |

---

## `/api/tts`

Convert text to natural speech with OpenAI TTS (`gpt-4o-mini-tts`, voice `nova` by
default; overridable with `OPENAI_TTS_MODEL` and `OPENAI_TTS_VOICE`). Audio is streamed
back as `audio/mpeg` so playback can begin before the whole clip is generated. Text is
truncated to 4,000 characters.

- `GET /api/tts?text=...` — used as an `<audio>` source for progressive playback.
- `POST /api/tts` with JSON `{ "text": "..." }` — same result.

| Condition | Status | Body |
|---|---|---|
| `OPENAI_API_KEY` not configured | 503 | plain text `OPENAI_API_KEY not set` |
| Invalid JSON (POST) | 400 | plain text `bad request` |
| Empty `text` | 400 | plain text `empty text` |
| Synthesis failed | 502 | plain text `tts failed` |

---

## `GET /api/health`

Returns `{ "status": "ok", "data_vintage": "..." }`. Use it to verify the app is up.
It does not check OpenAI or adsb.lol connectivity.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | OpenAI access for chat, STT, and TTS |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat model |
| `OPENAI_MAX_TOKENS` | `1500` | Per-completion token cap |
| `MAX_AGENT_STEPS` | `6` | Max model/tool iterations per turn |
| `OPENAI_STT_MODEL` | `whisper-1` | Speech-to-text model |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | `nova` | Text-to-speech voice |
| `NEXT_PUBLIC_API_BASE_URL` | empty | Only if the API is on a different origin than the UI |

The live-flights tool uses the free adsb.lol API and needs no key.

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
- Voice: record audio in the browser and send it to `/api/stt`; read answers aloud by
  pointing an audio element at `/api/tts`. The browser's built-in speech APIs are not used.

---

## Known limitations

- **No authentication or rate limiting on any `/api` route.** `/api/chat`, `/api/stt`,
  and `/api/tts` each trigger paid OpenAI calls, so an open deployment is exposed to
  cost abuse (denial of wallet). `/api/chat` also does not cap message or history length.
- **Estimated inputs.** Only BTS T-100 Domestic traffic (passengers and departures, 2024)
  and the OurAirports reference data (names, coordinates, runways) are real. Load factor,
  delays, cancellations, haul mix, and year-over-year growth are documented estimates.
  Passenger counts are domestic-only.
- **Load factor carries more weight than the headline tables show.** The congestion
  score is itself an input to the unmet-demand and expansion scores, so load factor
  enters those scores twice. Effective weights, computed from `lib/scoring.ts`:

  | Input | Congestion | Unmet demand | Expansion |
  |---|---|---|---|
  | Load-factor pressure | 20.0% | 47.0% | 31.0% |
  | Share of departures delayed >15 min | 35.0% | 12.25% | 10.5% |
  | Average departure delay | 30.0% | 10.5% | 9.0% |
  | Cancellation rate | 15.0% | 5.25% | 4.5% |
  | Growth vs. capacity (growth and runway throughput) | — | 25.0% | — |
  | Demand growth | — | — | 30.0% |
  | Passenger volume upside | — | — | 15.0% |

  For expansion, load factor (31%) is therefore the largest single input alongside
  demand growth (30%), versus the 25% documented. Since load factor is an estimate,
  that estimate has an outsized effect on rankings.
- **Coverage.** About 28 major and mid-size U.S. airports; not every airport.
- **No table on unmatched input.** If a ranking's `scope` matches zero airports, the
  tool returns an error with a hint (covered states and valid scopes) and no structured
  payload; the same applies to a comparison that names an airport outside the dataset.
  The reply then relies on the model relaying that message, and the turn has no table.
- **Live flights** are a point-in-time count within roughly 30 nm of the airport from a
  community ADS-B feed, and can be unavailable; the agent then reports that plainly.

## Next steps

- Authentication and per-client rate limiting and usage caps on all `/api` routes;
  input length limits on chat and TTS.
- An evaluation suite that runs fixed question sets end to end and checks tool choice,
  numbers, and the "no invented airports" rule, to catch regressions when prompts or
  models change.
- Real delay and load-factor data (BTS On-Time, T-100 Segment, FAA ASPM) in place of
  estimates, which also removes the sensitivity described above.
- Observability: structured request logs, per-turn tool traces, latency and token/cost
  metrics, and alerting on error rates.
