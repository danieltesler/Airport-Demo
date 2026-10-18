/**
 * Reads "LAX and SNA", "JFK vs EWR", "Los Angeles and Santa Ana" or "JFK, LGA and EWR" as a
 * list of specific airports. Deterministic: a part is an airport only if it is an IATA code in
 * the dataset or exactly a dataset airport's city name. Anything else (a metro, a state, a
 * region) is an area, which the caller resolves with the scope resolver.
 *
 * Why this exists: a model told to pass place words verbatim often sends "LAX and SNA" as the
 * place and leaves the airport codes out, and resolving that text as an area would silently
 * compare a whole metro or state.
 */

import * as data from "./data";
import type { Airport } from "./data";

export type NamedAirports =
  | { kind: "airports"; airports: Airport[]; parts: string[] }
  | { kind: "ambiguous"; part: string; candidates: Airport[] };

const SEPARATORS = /\b(?:and|vs\.?|versus|v|with|or|against)\b|[,&/;+]/gi;
const FILLER =
  /\b(?:compare|comparing|comparison|congestion|congested|delays?|delayed|airports?|between|the|levels?|metrics?|how|does|do|is|are|more|less|than|which|expansion|unmet|demand)\b/gi;

const clean = (part: string): string => part.replace(FILLER, " ").replace(/[^\p{L}\p{N}.' -]/gu, " ").replace(/\s+/g, " ").trim();

/** The airports in `text` when it names two or more specific airports; null when it should be read as an area. */
export function namedAirports(text: string | undefined): NamedAirports | null {
  const parts = (text ?? "")
    .split(SEPARATORS)
    .map(clean)
    .filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const found: Airport[] = [];
  for (const part of parts) {
    const byCode = /^[A-Za-z]{3}$/.test(part) ? data.getAirport(part) : undefined;
    const candidates = byCode ? [byCode] : data.allAirports().filter((a) => a.city.toLowerCase() === part.toLowerCase());
    if (candidates.length === 0) return null; // not a specific airport: let the scope resolver read the whole text
    if (candidates.length > 1) return { kind: "ambiguous", part, candidates };
    found.push(candidates[0]);
  }
  const unique = found.filter((a, i) => found.findIndex((o) => o.iata === a.iata) === i);
  return { kind: "airports", airports: unique, parts };
}
