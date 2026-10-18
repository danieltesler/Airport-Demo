/**
 * TypeScript types for the /api/chat request/response shapes used by this app.
 * They are the single source of truth for those shapes on the frontend; `caption`
 * and `explain` on StructuredResult are code-generated and never reach the model.
 */

/** A single conversation turn, as stored in the transcript and sent as history. */
export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /**
   * Optional, assistant turns only: the `shown` note the server returned with that answer
   * (what was on screen: table rows in order). Sent back so follow-ups keep their referent.
   */
  shown?: string;
}

/** Request body for POST /api/chat. */
export interface ChatRequest {
  message: string;
  history: ChatTurn[];
}

/** The kinds of structured payloads the agent can return. */
export type StructuredKind = "ranking" | "comparison" | "breakdown" | "metric";

/** A table cell is either a label (string) or a numeric measure. */
export type Cell = string | number;

/** Tabular / ranking data rendered as a table and optionally a bar chart. */
export interface StructuredResult {
  kind: StructuredKind;
  columns: string[];
  rows: Cell[][];
  /** Code-owned line stating what was asked of the data (scope, count). Never sent to the model. */
  caption?: string;
  /** Optional per-airport score breakdown for the "How was this scored?" panel. */
  explain?: ScoreExplanation;
}

/** Real weights and per-airport contributions behind a composite score. */
export interface ScoreExplanation {
  metricLabel: string;
  /** Components in weight order; `parts` in each row follows the same order. */
  components: { label: string; weight: number }[];
  rows: {
    airport: string;
    score: number;
    /** value = normalized 0-1 component; points = its contribution to the 0-100 score. */
    parts: { value: number; points: number }[];
  }[];
}

/** Transparency metadata about how the answer was produced. */
export interface ResponseMeta {
  tools_used?: string[];
  data_vintage?: string;
  timings?: TurnTimings;
  /** Which path produced the voice line: the verified model line, the client template, or neither. */
  spoken_source?: "model" | "template" | "none";
  /** How many checks rejected the model's spoken line (a count only, no content). Present when it was rejected. */
  spoken_guard_rejections?: number;
}

/** Where time went in one turn, in milliseconds. */
export interface TurnTimings {
  total_ms: number;
  model_calls: number;
  model_ms: number;
  tools_ms: number;
  /** One entry per model call: its duration and the tools it triggered. */
  hops: { model_ms: number; tools: { name: string; ms: number }[] }[];
}

/** Response body for POST /api/chat. `reply` is the only guaranteed field. */
export interface ChatResponse {
  reply: string;
  structured?: StructuredResult | null;
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
  /** The verified line to read aloud. Omitted unless the server-side guard accepted it. */
  spoken?: string;
  /** Code-built note of what is on screen for this answer; send it back as `shown` on this turn in `history`. */
  shown?: string;
  /** Present only on error responses; for logs/debug, never shown to the user. */
  error?: string;
}

/** Response body for GET /api/health. */
export interface HealthResponse {
  status: string;
  data_vintage?: string;
}

/**
 * A rendered assistant message keeps the raw reply plus any structured extras
 * so the UI can lay them out together beneath the bubble.
 */
export interface AssistantMessage extends ChatTurn {
  role: "assistant";
  structured?: StructuredResult | null;
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
}

export interface UserMessage extends ChatTurn {
  role: "user";
}

export type TranscriptMessage = UserMessage | AssistantMessage;

/**
 * The non-text extras of an assistant answer (structured table, assumptions,
 * uncertainty, provenance). assistant-ui only models the reply text natively,
 * so we carry these through each assistant message's `metadata.custom` and
 * render them beneath the message. See components/assistant/AssistantMessage.tsx.
 */
export interface AssistantExtras {
  structured?: StructuredResult | null;
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
  /** What is read aloud, built client-side by lib/spoken.ts from `structured` (never from model text when a table exists). */
  spoken?: string | null;
  /** The server's "shown on screen" note for this answer, sent back as `shown` in the next request's history. */
  shown?: string | null;
  /** Set when the turn failed; the UI uses its presence only to style the reply as an error. */
  error?: string | null;
}
