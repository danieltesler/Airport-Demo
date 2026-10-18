/**
 * Limits on what /api/chat sends to the paid model. The history is client-supplied and
 * unsigned, so it is validated here before it reaches the model: right shape, last turns only,
 * bounded size.
 */

import { cleanShownNote } from "./shownNote";
import type { ChatTurn } from "./types";

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_HISTORY_TURNS = 12;
export const MAX_TURN_CHARS = 2000;

/** A safe history: allow-listed roles, string content capped, `shown` only on assistant turns, last 12 turns. */
export function sanitizeHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  const turns: ChatTurn[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const { role, content, shown } = item as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content) continue;
    const turn: ChatTurn = { role, content: content.slice(0, MAX_TURN_CHARS) };
    if (role === "assistant" && typeof shown === "string") {
      const note = cleanShownNote(shown);
      if (note) turn.shown = note;
    }
    turns.push(turn);
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}
