/**
 * Answers to a clarifying question: after "Dallas has two airports, DAL or DFW?" the user says "DFW please",
 * "use DFW" or "Love Field". The model sees that in the conversation, but the tools only see the new
 * message, so the code rebuilds the question the user is really asking: the previous user message with the
 * ambiguous city replaced by the airport they chose.
 */

import * as data from "./data";
import { collapseSpelledLetters } from "./spelledCodes";
import type { Airport } from "./data";
import type { ChatTurn } from "./types";

const FILLER_WORDS = new Set(["international", "airport", "regional", "municipal", "the", "of", "and", "field", "intl"]);

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);

/** The airports the last assistant turn offered as options ("... (scope: DFW); ... (scope: DAL)"), if it did. */
function offeredAirports(turn: ChatTurn | undefined): Airport[] {
  if (!turn || turn.role !== "assistant" || typeof turn.shown !== "string") return [];
  if (!turn.shown.includes("Options offered to the user")) return [];
  const codes = [...turn.shown.matchAll(/scope: ([A-Z]{3})\)/g)].map((m) => m[1]);
  return codes.map((code) => data.getAirport(code)).filter((a): a is Airport => Boolean(a));
}

/** Words that tell one offered airport from the others (its code, or "love", "fort", "worth"). */
function distinctiveWords(candidate: Airport, others: Airport[]): Set<string> {
  const ownWords = new Set([...words(candidate.name), ...words(candidate.city), candidate.iata.toLowerCase()]);
  for (const other of others) for (const w of [...words(other.name), ...words(other.city), other.iata.toLowerCase()]) ownWords.delete(w);
  for (const filler of FILLER_WORDS) ownWords.delete(filler);
  return ownWords;
}

function chosenAirport(reply: string, candidates: Airport[]): Airport | null {
  const said = new Set(words(collapseSpelledLetters(reply)));
  const hits = candidates.filter((candidate) => {
    const distinctive = distinctiveWords(candidate, candidates.filter((c) => c !== candidate));
    return [...distinctive].some((w) => said.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Replace each whole-word, case-insensitive occurrence of `word` in `text` with `replacement`. */
function replaceWord(text: string, word: string, replacement: string): string {
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const at = lower.indexOf(word.toLowerCase(), from);
    if (at < 0) return out + text.slice(from);
    const before = at === 0 ? "" : lower[at - 1];
    const after = lower[at + word.length] ?? "";
    const boundary = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    out += text.slice(from, at) + (boundary ? replacement : text.slice(at, at + word.length));
    from = at + word.length;
  }
}

/**
 * The message the tools should read: when this message answers the options just offered, the previous user
 * message with the chosen airport's code in place of the ambiguous city; otherwise the message unchanged.
 */
export function effectiveMessage(message: string, history: ChatTurn[]): string {
  const offeredBy = history.at(-1);
  const candidates = offeredAirports(offeredBy);
  if (candidates.length < 2) return message;
  const chosen = chosenAirport(message, candidates);
  if (!chosen) return message;
  const asked = history.at(-2);
  if (!asked || asked.role !== "user") return message;

  let rebuilt = asked.content;
  for (const part of chosen.city.split(/[-/,]/).map((p) => p.trim()).filter(Boolean)) {
    rebuilt = replaceWord(rebuilt, part, chosen.iata);
  }
  return rebuilt === asked.content ? `${asked.content} (${chosen.iata})` : rebuilt;
}
