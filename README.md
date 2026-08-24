# Airport Investment Intelligence Agent

A conversational AI agent that helps investment analysts identify U.S. airports
where **terminal renovation would be most profitable** — where growing flight and
passenger demand is running into constrained capacity.

Ask it questions in plain English (typed or by voice):

- *Which airports in New England are strong candidates for terminal expansion?*
- *Compare LA and Santa Ana airport congestion levels.*
- *What is the percentage of long-haul flights out of Anchorage?*
- *What is the unmet flight demand at SFO, and why?*

Every answer combines a clear explanation, a structured table/chart, and an explicit
**assumptions & uncertainty** panel.

---

## How it works (in one picture)

```
Frontend (Next.js + TypeScript)  ──POST /api/chat──▶  Backend (FastAPI + Python)
  chat · charts · voice                                 Claude  ──▶  deterministic
                                 ◀───── reply ─────      (language +      scoring engine
                                                          orchestration)  (every number)
```

- **Claude** interprets questions, picks tools, and explains results — but never
  invents a number.
- A **deterministic scoring engine** (pure Python, unit-tested) computes every
  metric and score, and owns the assumptions and uncertainty shown to the user.

See **[docs/DESIGN.md](docs/DESIGN.md)** for the scoring methodology, tradeoffs, and
where/how AI is used, and **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)** for the
frontend/backend contract.

---

## Quick start

You need **one** secret: an Anthropic API key.

### 1. Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # paste your ANTHROPIC_API_KEY into .env
uvicorn app.main:app --reload --port 8000
```

### 2. Frontend (in a second terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000**.

### Tests

```bash
cd backend && pytest          # deterministic scoring + data layer
```

---

## Project layout

```
backend/    FastAPI app, Claude agent loop, deterministic scoring engine, dataset, tests
frontend/   Next.js + TypeScript chat UI (Markdown, tables/charts, voice)
docs/       DESIGN.md (methodology & tradeoffs) + API_CONTRACT.md
```

---

## Data & cost

- **Free and key-free by design**, except the Anthropic API key.
- Reference/geo from **OurAirports** (public domain); traffic and delay metrics are a
  curated snapshot of **BTS T-100 + On-Time Performance** public data (BTS has no live
  API — it's bulk download). `backend/data/build_dataset.py` documents the provenance
  and the path to full automated ingestion.

## Deploy (later)

Standard Next.js frontend deploys to Vercel as-is; set `NEXT_PUBLIC_API_BASE_URL` to
the deployed backend. Host the Python backend anywhere Python runs and keep
`ANTHROPIC_API_KEY` in the platform's environment (never in the repo).

## Scope & honesty

This is a one-day demo. Scores reflect **demand-side opportunity** on a curated
snapshot of ~28 major/mid-size U.S. airports — not a full investment model (no
construction cost, land, or regulatory limits). Assumptions and uncertainty are shown
on every answer, and detailed in the design doc.
