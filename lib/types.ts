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
  notes: string[];
}

/** Transparency metadata about how the answer was produced. */
export interface ResponseMeta {
  tools_used?: string[];
  data_vintage?: string;
}

/** Response body for POST /api/chat. `reply` is the only guaranteed field. */
export interface ChatResponse {
  reply: string;
  structured?: StructuredResult | null;
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
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
  /** Set when the turn failed; the UI uses its presence only to style the reply as an error. */
  error?: string | null;
}
