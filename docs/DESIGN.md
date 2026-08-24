# Design & Architecture — Airport Investment Intelligence Agent

A conversational agent that helps investment analysts identify U.S. airports where
terminal renovation would be most profitable — driven by growing flight and
passenger demand meeting constrained capacity.

This document covers the **scoring methodology**, **key tradeoffs**, and **where/how
AI is used** — plus the data sources and the explicit assumptions and scoping behind
the analysis.

---

## 1. What it does

An analyst chats with the agent in natural language (typed or by voice) and asks
questions like:

| Question | How it's answered |
|---|---|
| Which New England airports are strong candidates for terminal expansion? | `rank_airports(scope="new_england", metric="expansion")` |
| Compare LA and Santa Ana congestion levels. | `compare_airports(["LAX","SNA"], metric="congestion")` |
| What % of flights out of Anchorage are long-haul? | `long_haul_breakdown("ANC")` |
| What is the unmet flight demand at SFO, and why? | `unmet_demand("SFO")` |

Every answer shows the natural-language explanation, a structured table/chart, and
an **assumptions & uncertainty** panel.

---

## 2. Architecture

A **single Next.js (TypeScript) application**. The chat UI and the agent API live in
one codebase and deploy as one unit — the browser calls the app's own `/api` routes
(same-origin, no CORS, no separate backend to host).

```
┌───────────────────────────── Next.js app ─────────────────────────────┐
│                                                                        │
│  Browser (React chat UI)          Server (Route Handlers)              │
│  • assistant-ui chat        ──▶   app/api/chat    ──▶  lib/agent.ts     │
│  • Markdown answers                (POST)               │  LLM loop     │
│  • structured table/chart   ◀──   { reply, ... }       ▼               │
│  • assumptions panel                              lib/tools.ts          │
│  • voice (Web Speech API)         app/api/health       │  └▶ lib/scoring.ts
│                                    (GET)               lib/data.ts       │
│                                                   (deterministic engine) │
└────────────────────────────────────────────────────────────────────────┘
```

**Layered, each layer with one job:**

- `app/api/chat/route.ts` — HTTP boundary. Validates input, delegates, always returns
  a renderable `reply` (even on error). Runs on the Node.js runtime (the OpenAI SDK
  needs it).
- `lib/agent.ts` — the LLM tool-use loop (OpenAI, via the `openai` SDK). Language and
  orchestration only; the provider lives only in this file.
- `lib/tools.ts` — the bridge: typed functions the model may call. Every number the
  user sees originates here. Also holds the provider-neutral tool schemas.
- `lib/scoring.ts` — the deterministic engine: pure functions, no I/O, no LLM.
- `lib/data.ts` — data access over the bundled dataset (imported as JSON, so it's
  available in any runtime with no filesystem access).

The design goal is **isolation and testability**: `scoring.ts` and `data.ts` are
covered by unit tests (Vitest) and are meaningful entirely without the LLM.

---

## 3. Scoring methodology

The scoring is deterministic — computed in code, not produced by the LLM. All scores
are **transparent weighted sums** of sub-metrics, each normalized to 0–1 against a
**fixed, documented reference scale** and reported on a 0–100 scale. Fixed scales
(rather than dataset-relative z-scores) mean a score means the same thing no matter
which airports are loaded, and results are stable and reproducible.

Reference anchors live in one place at the top of `lib/scoring.ts` (e.g. "30 min
average delay = fully congested", "10% YoY growth = maximal demand signal"). Every
weight is one edit away from being challenged and re-tuned.

### 3.1 Congestion index (0–100)

Operational strain, judged as **rates** so large hubs and small airports are
comparable:

| Component | Weight | Reference (maps to 1.0) |
|---|---|---|
| Share of departures delayed >15 min | 0.35 | 35% |
| Average departure delay | 0.30 | 30 min |
| Cancellation rate | 0.15 | 5% |
| Load-factor pressure | 0.20 | 90% load (floor 70%) |

### 3.2 Long-haul mix

Not a score but a factual breakdown: share of **departures** by great-circle
distance — short (<1,100 mi), medium (1,100–2,200), long (>2,200) — from T-100
segment distances.

### 3.3 Unmet-demand proxy (0–100)

"Unmet demand" is not directly measurable in free data, so it's an explicit
**composite lower-bound proxy**:

| Driver | Weight | Rationale |
|---|---|---|
| Load-factor pressure | 0.40 | Sustained high seat use ⇒ demand supply can't absorb |
| Congestion | 0.35 | Delay/throughput gap ⇒ demand above capacity |
| Growth vs. capacity | 0.25 | Fast growth against fixed runways ⇒ widening gap |

### 3.4 Expansion attractiveness (0–100) — the headline investment score

The thesis: expansion is most profitable where **strong, growing demand meets a
capacity-constrained airport**, so renovation unlocks revenue rather than adding
idle space.

| Component | Weight | Why it matters to the investment |
|---|---|---|
| Demand growth | 0.30 | Future demand to justify the build |
| Congestion | 0.30 | Strain today that expansion would relieve |
| Load-factor pressure | 0.25 | Seats already scarce |
| Passenger volume upside | 0.15 | Scale of travelers who benefit |

---

## 4. Where and how AI is used

Deliberately scoped. **The LLM never produces a number.**

- **The LLM (OpenAI, `gpt-4o-mini`) does:** interpret the analyst's intent, pick the
  right tool and arguments, carry the conversation and follow-ups, and explain the
  returned numbers in clear prose. It runs as a bounded tool-use loop in `lib/agent.ts`.
- **The deterministic engine does:** compute every metric, ranking, and score, and
  own the canonical assumptions and uncertainty text.

Crucially, the **assumptions, uncertainty, and structured table shown in the UI
come from the code, not the model** (`lib/agent.ts` collects them from each tool's
output). So this transparency is *guaranteed by construction*, not left to the
model's discretion. A wrong model response can be unhelpful, but it
cannot silently fabricate a figure or hide a caveat.

The tool-use loop is bounded (`MAX_AGENT_STEPS`) as a safety limit.

---

## 5. Data sources

| Layer | Source | Access |
|---|---|---|
| Reference / geo (name, IATA/ICAO, state, coords, runways) | **OurAirports** | Public-domain CSV, no key |
| Traffic, seats, distance, load factor, haul mix | **BTS T-100 Segment** | Free, download-only (no API) |
| Delays, cancellations | **BTS On-Time Performance** | Free, download-only (no API) |

Because BTS has **no live API** (bulk CSV only), the app ships a **curated snapshot**
(`data/airports.json`, ~28 major + mid-size airports) so it runs offline, free, and
key-free. It's a deliberate tradeoff: the snapshot documents the exact BTS tables it
is compiled from, and the path to a full automated ingest (download → aggregate per
airport/year) is straightforward.

---

## 6. Key tradeoffs

- **Single Next.js app (one language) vs. a separate Python service.** Folding the
  agent into TypeScript route handlers makes it one codebase that deploys to Vercel in
  one click, with the API served same-origin (no CORS, no second host). *Tradeoff:* we
  don't run a separate Python backend, but we gain a dramatically simpler, more
  reliable deployment.
- **Curated snapshot vs. live ingestion.** A full BTS pipeline (gigabytes of CSVs)
  would be over-engineering at this stage and adds fragility. We bundle a validated
  snapshot and document the scale-up path. *Tradeoff:* data isn't real-time (BTS
  itself lags 1–2 months anyway).
- **Fixed reference scales vs. dataset-relative normalization.** Fixed scales give
  stable, portable, explainable scores. *Tradeoff:* the anchors are judgment calls;
  they're centralized and documented so they can be tuned.
- **Deterministic transparency vs. letting the LLM summarize.** Assumptions and the
  numbers come from code. *Tradeoff:* slightly less "fluid" than a pure-LLM answer,
  but trustworthy and auditable — the right call for investment decisions.
- **Demand-side scoring vs. full investment model.** Scores reflect demand
  opportunity, not construction cost, land/gate availability, or noise curfews.
  Kept out to stay clear and honest rather than pretend precision.
- **Voice via browser Web Speech API vs. a cloud speech service.** Free, no key, no
  server load. *Tradeoff:* quality/availability vary by browser (best in
  Chrome/Edge); controls hide gracefully where unsupported.

---

## 7. Assumptions, uncertainty & scoping (stated plainly)

- **Scope:** ~28 major and selected mid-size U.S. airports — enough to answer the
  questions above credibly; not every U.S. airport.
- **Vintage:** a single recent full-year snapshot; no intra-year seasonality.
- **Congestion** mixes weather with true capacity saturation; annual averages smooth
  out peak-day spikes.
- **Unmet demand** is a lower-bound proxy — bookings that never happened (priced-out
  or sold-out demand) aren't in free data; that needs proprietary GDS/OAG/Cirium.
- **Expansion score** is demand-side only, as noted above.

These are surfaced to the user on every answer, not buried here.

---

## 8. If we had more time

- Full automated BTS ingestion with multi-year trends (real growth, seasonality).
- FAA ASPM demand-vs-capacity ratios for a stronger congestion/unmet signal.
- A live OpenSky "flights right now" panel for real-time flavor.
- Cost side of the investment case (capex, gate/land constraints) to turn the
  demand score into a true ROI ranking.
- A small map view using the coordinates already in the dataset.
