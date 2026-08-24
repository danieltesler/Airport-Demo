# API Contract — Airport Investment Intelligence Agent

The frontend (Next.js / TypeScript) talks to the backend (Python) through this
single, stable contract. Both sides can be built independently against it.

Base URL (local dev): `http://localhost:8000`

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

- `message` — required, the latest user turn.
- `history` — optional, prior turns in order (oldest first). Enables conversational
  follow-ups. May be empty on the first turn.

### Response body

```json
{
  "reply": "**LAX** is more congested than **Santa Ana (SNA)** ...",
  "structured": {
    "kind": "comparison",
    "columns": ["Airport", "Congestion score", "Avg departure delay (min)", "Load factor"],
    "rows": [
      ["LAX", 78.4, 14.2, 0.86],
      ["SNA", 41.0, 8.1, 0.79]
    ]
  },
  "assumptions": [
    "Congestion is proxied by average departure delay and load factor (see design doc).",
    "Data reflects the latest full year available in the bundled dataset."
  ],
  "uncertainty": "Delay data has monthly granularity; short-term congestion spikes are not captured.",
  "meta": {
    "tools_used": ["compare_airports"],
    "data_vintage": "BTS T-100 / On-Time 2024"
  }
}
```

- `reply` — **required**, Markdown string. The natural-language answer to render.
- `structured` — **optional**, present when there is tabular/ranking data to render
  as a table or bar chart. `kind` is one of `ranking` | `comparison` | `breakdown` |
  `metric`. When `kind` is `breakdown` (e.g. long-haul %), rows are label/value pairs.
- `assumptions` — **optional** array of short strings; render in a subtle panel.
- `uncertainty` — **optional** string or null; render alongside assumptions.
- `meta` — **optional**; `tools_used` and `data_vintage` for transparency.

### Error response (any 4xx/5xx)

```json
{ "reply": "I hit an error reaching the data layer. ...", "error": "short_code" }
```

The frontend always renders `reply`; `error` is for logs/debug only.

---

## `GET /api/health`

Returns `{ "status": "ok", "data_vintage": "..." }`. Used to verify the backend is up.

---

## Notes for the frontend

- Always render `reply` as Markdown.
- If `structured` is present, render it as a small table; a bar chart is a nice-to-have
  for `ranking`/`comparison`/`breakdown`.
- Always surface `assumptions` and `uncertainty` when present — clearly communicating
  assumptions, uncertainty, and scoping is a core goal of the product.
- Voice: use the browser Web Speech API — `SpeechRecognition` for mic input,
  `speechSynthesis` for reading `reply` aloud. No server involvement, no API key.
