# Airport Investment Intelligence Agent

A conversational AI agent that helps investment analysts identify U.S. airports
where **terminal renovation would be most profitable** — where growing flight and
passenger demand is running into constrained capacity.

Ask it anything about U.S. airport capacity, congestion, and demand — in plain English
or Hebrew, typed or by voice. These are just a few examples:

- *Which airports in New England are strong candidates for terminal expansion?*
- *Compare LA and Santa Ana airport congestion levels.*
- *What is the percentage of long-haul flights out of Anchorage?*
- *What is the unmet flight demand at SFO, and why?*

It's not limited to these. You can rank any region or state by expansion, congestion,
or unmet-demand potential; compare any airports head-to-head; pull a single airport's
full profile; and ask natural follow-ups — across the airports in its dataset.

Every data-backed answer combines a clear explanation, a structured table/chart, and an
explicit **assumptions & uncertainty** panel.

---

## How it works (in one picture)

```
Browser (assistant-ui chat)  ──POST /api/chat──▶  Next.js Route Handler
  chat · tables/charts · voice                       LLM  ──▶  deterministic
                             ◀───── reply ─────       (language +   scoring engine
                                                       tool use)    (every number)
```

Everything is **one Next.js app**. The chat UI calls the app's own same-origin
`/api/chat` route; no separate backend host and no CORS.

- The **LLM** interprets questions, picks tools, and explains results — but never
  invents a number.
- A **deterministic scoring engine** (pure TypeScript, unit-tested) computes every
  metric and score, and owns the assumptions and uncertainty shown to the user.

See **[docs/DESIGN.md](docs/DESIGN.md)** for the scoring methodology and where AI is
used, and **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)** for the request/response
contract the UI and route share.

---

## Tech stack

- **Next.js (App Router) + TypeScript** — single app; UI and the `/api` routes live
  together.
- **[assistant-ui](https://github.com/assistant-ui/assistant-ui)** — the chat
  experience is built from assistant-ui primitives driven by a `LocalRuntime` whose
  custom `ChatModelAdapter` talks to our `/api/chat`. Replies render as Markdown via
  `@assistant-ui/react-markdown`.
- **Plain CSS** — global design tokens in `app/globals.css` plus CSS Modules per
  component (`components/assistant/chat.module.css`). No Tailwind or CSS framework.
- **Voice (Web Speech API, no keys)** — mic **dictation** with an **EN / עב** language
  toggle: it recognizes English or Hebrew and auto-sends when you stop speaking.
  **Read-aloud** strips Markdown and speaks each answer in its own language (Hebrew →
  `he-IL`, otherwise `en-US`). All controls are feature-detected and hidden where
  unsupported.

---

## Quick start

You need **one** secret: your **OpenAI API key** (`OPENAI_API_KEY`, see `.env.example`).

```bash
npm install
cp .env.example .env.local     # paste your API key into .env.local
npm run dev
```

Open **http://localhost:3000**.

### Scripts

```bash
npm run dev         # local dev server
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm run test        # vitest — deterministic scoring + tools
```

---

## Project layout

```
app/
  api/chat/route.ts     POST /api/chat — the agent turn
  api/health/route.ts   GET  /api/health
  layout.tsx, page.tsx  app shell + single chat page
  globals.css           design tokens + Markdown styles
components/
  assistant/            assistant-ui integration (provider, thread, message,
                        composer, VoiceInput, markdown, example chips) + chat.module.css
  StructuredResult.tsx  table + CSS bar chart for `structured` payloads
  AssumptionsPanel.tsx  assumptions / uncertainty / provenance panel
lib/
  chatModelAdapter.ts   maps assistant-ui messages ⇄ the /api/chat contract
  speechAdapters.ts     Markdown-aware, language-aware read-aloud adapter
  api.ts                typed same-origin client for /api
  agent.ts, tools.ts, scoring.ts, data.ts   LLM loop + deterministic engine
  types.ts              the contract types (source of truth)
hooks/
  useDictation.ts       Web Speech mic dictation (EN/he) + auto-send
  useSpeechSupport.ts   feature-detection for read-aloud
data/airports.json      curated public dataset
docs/                   DESIGN.md + API_CONTRACT.md
```

---

## Deploy to Vercel

This is a **single Next.js app**, so it's a one-click deploy — no separate backend,
no `vercel.json` gymnastics.

1. Push to GitHub and **Import** the repo into Vercel (New Project → Import Git
   Repository). Leave the framework preset and build settings at their defaults.
2. Under **Environment Variables**, add `OPENAI_API_KEY` (the same key from
   `.env.example`). Set it for all environments. Optionally add `OPENAI_MODEL`.
3. **Deploy.** Once live, `GET /api/health` and `POST /api/chat` resolve on the same
   domain as the UI.

Never commit a real key — `.env.local` is git-ignored and the key is read from the
environment at runtime.

---

## Data & cost

- **Free and key-free by design**, except the model-provider API key.
- Reference/geo from **OurAirports** (public domain); traffic and delay metrics are a
  curated snapshot of **BTS T-100 + On-Time Performance** public data.

## Scope

Scores reflect **demand-side opportunity** on a curated snapshot of mid-to-large
U.S. airports — not a full investment model (they don't yet weigh construction cost,
land/gate availability, or regulatory limits). Assumptions and uncertainty are shown
on every answer and detailed in the design doc.
</content>
