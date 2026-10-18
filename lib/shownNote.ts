/**
 * The "Shown on screen last turn" note: a short, code-built description of what the user can
 * see after an answer (table caption and the row labels in order, or the options we offered).
 *
 * Replies no longer repeat table rows, so without this a follow-up such as "what about the
 * second one?" has no referent. The note carries labels only, never metrics: if the user wants
 * numbers the model must call a tool again.
 */

import type { StructuredResult } from "./types";

export const MAX_SHOWN_CHARS = 800;
const MAX_ROWS_IN_NOTE = 10;

const AIRPORT_LABEL = /^[A-Z0-9]{3} — /;

/** The label of a table row: its airport cell when it has one, else its first text cell. */
function rowLabel(row: StructuredResult["rows"][number]): string | null {
  const cells = row.filter((cell): cell is string => typeof cell === "string");
  return cells.find((cell) => AIRPORT_LABEL.test(cell)) ?? cells[0] ?? null;
}

/** Options from an ambiguous tool result, as "label (scope)" text. */
function optionsText(toolResults: Record<string, unknown>[]): string | null {
  for (const result of toolResults) {
    const options = result.options;
    if (result.status !== "ambiguous" || !Array.isArray(options) || options.length === 0) continue;
    const listed = options
      .filter((o): o is { label: string; scope: string } => typeof o?.label === "string" && typeof o?.scope === "string")
      .map((o) => `${o.label} (scope: ${o.scope})`);
    if (listed.length > 0) return `Options offered to the user: ${listed.join("; ")}.`;
  }
  return null;
}

/** Collapse anything that could fake structure in a prompt (newlines, brackets) and cap the length. */
export function cleanShownNote(text: string): string {
  return text.replace(/[\r\n[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SHOWN_CHARS);
}

/** The note for this turn, or undefined when nothing was shown. */
export function buildShownNote(
  structured: StructuredResult | null,
  toolResults: Record<string, unknown>[] = [],
): string | undefined {
  const parts: string[] = [];
  if (structured && structured.rows.length > 0) {
    const labels = structured.rows
      .slice(0, MAX_ROWS_IN_NOTE)
      .map((row, i) => {
        const label = rowLabel(row);
        return label ? `${i + 1} ${label}` : null;
      })
      .filter((entry): entry is string => entry !== null);
    const caption = structured.caption ? `"${structured.caption}". ` : "";
    parts.push(`Table (${structured.kind}): ${caption}Rows in order: ${labels.join("; ")}.`);
  }
  const options = optionsText(toolResults);
  if (options) parts.push(options);
  return parts.length > 0 ? cleanShownNote(parts.join(" ")) : undefined;
}
