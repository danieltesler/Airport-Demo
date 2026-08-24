# Backend — Airport Investment Intelligence Agent

Python (FastAPI) service that runs the conversational agent. Claude handles
language and orchestration; a deterministic scoring engine produces every number.

## Prerequisites

- Python 3.11+
- An Anthropic API key

## Setup

```bash
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # then edit .env and paste your ANTHROPIC_API_KEY
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

- Health check: http://localhost:8000/api/health
- Chat endpoint: `POST http://localhost:8000/api/chat` (see `../docs/API_CONTRACT.md`)

The server starts even without an API key; `/api/chat` then returns a clear message
telling you to add the key.

## Test

```bash
pytest
```

Tests cover the deterministic scoring engine and the data layer — the parts that
must be reproducible independent of the LLM.

## Layout

```
app/
  main.py       FastAPI app + endpoints (thin; validates and delegates)
  agent.py      Claude tool-use loop (language + orchestration only)
  tools.py      Agent tools: bridge from LLM to data + scoring; Anthropic tool schemas
  scoring.py    Deterministic scoring engine (pure functions, no I/O, no LLM)
  data.py       Data access over the bundled dataset
  config.py     Env-driven configuration
data/
  airports.json      Curated public-data snapshot (BTS + OurAirports)
  build_dataset.py   Provenance + refresh/validate tool  (python build_dataset.py --check)
tests/
  test_scoring.py    Scoring + data-layer tests
```

## Data

See `data/build_dataset.py` for full provenance. In short: reference/geo from
**OurAirports** (public domain), traffic/delay metrics a curated snapshot of
**BTS T-100 + On-Time Performance** public data. BTS has no live API (download
only), so the demo bundles a snapshot with a documented path to full ingestion.

## Deploy notes (Vercel)

The frontend deploys to Vercel directly. For the backend, either deploy it as a
Vercel Python serverless function or host it on any Python-friendly platform and
point the frontend's `NEXT_PUBLIC_API_BASE_URL` at it. Keep `ANTHROPIC_API_KEY`
in the platform's environment settings — never in the repo.
