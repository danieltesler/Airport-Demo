# Airport Investment Intelligence Agent

A chat assistant for analysts who invest in U.S. airport upgrades. You ask it
questions about airports in ordinary language, and it points you toward the ones where
a terminal expansion is most likely to pay off: places where demand is growing and
starting to run into the limits of what the airport can handle.

You can type or talk to it, in English or Hebrew.

## What you can ask

It was built around four questions to start with:

- Which airports in New England are strong candidates for terminal expansion?
- Compare LA and Santa Ana congestion levels.
- What share of flights out of Anchorage are long-haul?
- What's the unmet demand at SFO, and why?

It isn't limited to those, though. You can rank any region or state, compare any
airports side by side, pull up a single airport's full profile, check how many flights
are in the air near an airport right now, or just follow up on a previous answer. When an answer is backed by data it comes with the numbers in a
small table (and a bar chart where that helps), along with a short note on the
assumptions behind the score and where the data came from.

## How it works

It's a single Next.js app. The browser talks to the app's own `/api/chat` route, so
there's no separate backend to run and no cross-origin setup to worry about.

Two parts split the work:

- The language model reads your question, decides which tool to call, and writes the
  explanation. It never makes up a number.
- A plain TypeScript scoring engine does the actual math (the congestion,
  unmet-demand, and expansion scores) and writes the assumptions and caveats. It's
  deterministic and covered by tests, so the figures stay the same from one run to
  the next.

Keeping the numbers out of the model's hands is the point. You can open the code and
see exactly how any score was produced, rather than trusting the model to have added
it up correctly.

```
Browser (chat UI)  ──►  /api/chat  ──►  language model picks a tool
                                          │
                                          ▼
                              deterministic scoring engine
                                     (every number)
```

The scoring is written up in [docs/DESIGN.md](docs/DESIGN.md), and the exact
request/response shape is in [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

## Running it locally

You'll need Node 18+ and an OpenAI API key.

```bash
npm install
cp .env.example .env.local   # put your OPENAI_API_KEY in this file
npm run dev
```

Then open http://localhost:3000.

A few other scripts:

```bash
npm run build       # production build
npm run test        # unit tests for the scoring engine and tools
npm run typecheck   # type-check only
npm run build:data  # rebuild data/airports.json from the public sources
```

## Voice

Tap the mic and just talk — in English or Hebrew, no toggle. It records your voice,
transcribes it with OpenAI Whisper (which auto-detects the language), and sends the
message. The agent replies in whatever language you spoke, and each answer has a
"Read aloud" button that speaks it back with a natural OpenAI voice (English and
Hebrew each get their own). Recording needs a browser with microphone support.

## Deploying

Since it's just a Next.js app, Vercel is the easy path: import the repo, add
`OPENAI_API_KEY` to the project's environment variables, and deploy. There's nothing
else to configure. Keys live in the environment and never go into the repo
(`.env.local` is git-ignored).

The live-flights tool needs no key — it uses a free community ADS-B API — so there's
nothing else to set up.

## Project layout

```
app/
  api/chat/route.ts     the agent turn (POST /api/chat)
  api/health/route.ts   a health check
  layout.tsx, page.tsx  the app shell and the single chat page
  globals.css           design tokens and Markdown styles
components/
  assistant/            the chat UI, built on assistant-ui
  StructuredResult.tsx  the results table and bar chart
  AssumptionsPanel.tsx  the assumptions / uncertainty panel
lib/
  agent.ts              the model loop (the only file that talks to OpenAI)
  tools.ts              the tools the model can call
  scoring.ts            the deterministic scoring engine
  data.ts               access to the bundled dataset
  liveflights.ts        live ADS-B client (adsb.lol) for the "flights right now" tool
  i18n.ts               English / Hebrew strings for the code-owned text
  chatModelAdapter.ts   connects assistant-ui to /api/chat
  speechAdapters.ts     read-aloud via OpenAI TTS (voice per language)
hooks/
  useDictation.ts       records audio and transcribes it (Whisper, auto-detects language)
scripts/
  build-dataset.mjs     rebuilds the dataset from OurAirports + the BTS ArcGIS API
data/airports.json      the airport dataset the script produces
docs/                   the design doc and the API contract
```

## Where the data comes from

| Source | What it provides | Real or estimated |
|---|---|---|
| **BTS T-100 Domestic** (USDOT ArcGIS API) | passengers and departures per airport (2024, domestic) | real |
| **OurAirports** | name, city, state, coordinates, runways | real |
| **adsb.lol** | live aircraft near an airport, on request | real, live |
| *(no free API for these)* | load factor, delays, haul mix, year-over-year growth | estimated |

The first two are fetched by `npm run build:data` and written into `data/airports.json`,
which the app reads (those numbers change yearly at most). **adsb.lol** is called live,
only when you ask about current flights. The estimated fields are marked as such in the
dataset. One caveat: the BTS figures are domestic-only, so international traffic isn't
counted yet.

The only thing that costs anything to run is the OpenAI calls — no other keys needed.

## What it doesn't do

The scores look at the demand side only: how much traffic an airport has and how
close it is running to its limits. They don't factor in construction cost, available
land or gates, or local rules such as noise curfews, all of which a real investment
decision would weigh. Every answer says so, so the numbers aren't taken for more than
they are.
