# Frontend — Airport Investment Intelligence Agent

A Next.js (App Router) + TypeScript chat interface for the agent. It renders the
conversation, structured tables/bar charts, an "assumptions & uncertainty" panel,
and voice controls (dictation + read-aloud via the browser Web Speech API).

## Prerequisites

- Node.js 18.18+ (or 20+)
- The Python backend running (see `../backend/README.md`) at `http://localhost:8000`

## Setup

```bash
npm install
```

Optionally set the backend URL (defaults to `http://localhost:8000`):

```bash
cp .env.example .env.local
# edit NEXT_PUBLIC_API_BASE_URL if your backend runs elsewhere
```

## Run (development)

```bash
npm run dev
```

Open http://localhost:3000. Start the backend first, or the chat will show a
friendly "couldn't reach the analysis service" message.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on :3000 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Next.js lint |

## Structure

```
app/            Next.js App Router entry (layout, page, global styles)
components/      Presentational + orchestrator components (ChatWindow is the top-level)
hooks/          useChat (transcript + request lifecycle), useSpeech (Web Speech API)
lib/            api.ts (typed API client), types.ts (contract mirror), markdown, speech types
```

The API request/response types in `lib/types.ts` mirror `../docs/API_CONTRACT.md`.
The app never calls `fetch` outside `lib/api.ts`.

## Voice

- **Mic** dictates into the composer (`SpeechRecognition` / `webkitSpeechRecognition`).
- **Speaker** reads the latest answer aloud (`speechSynthesis`).

Both are feature-detected; unsupported browsers simply don't show the controls.
Best support is in Chrome/Edge.

## Deploy (Vercel)

This is a standard Next.js app and deploys to Vercel as-is. Set
`NEXT_PUBLIC_API_BASE_URL` in the Vercel project to your deployed backend URL.
