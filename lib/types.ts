/**
 * TypeScript mirror of the backend API contract (see docs/API_CONTRACT.md).
 * These types are the single source of truth for request/response shapes on
 * the frontend. Keep them in sync with the contract, not with backend internals.
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
}

/** Transparency metadata about how the answer was produced. */
export interface ResponseMeta {
  tools_used?: string[];
  data_vintage?: string;
  /** Language the deterministic strings were localized to (matches the user's). */
  lang?: "en" | "he";
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
}
