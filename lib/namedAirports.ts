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
import geography from "@/data/geography.json";
import { collapseSpelledLetters } from "./spelledCodes";

const STATE_ROWS = geography.states as { code: string; name: string }[];

export type NamedAirports =
  | { kind: "airports"; airports: Airport[]; parts: string[]; viaCity: boolean }
  | { kind: "ambiguous"; part: string; candidates: Airport[] };

const SEPARATORS = /\b(?:and|vs\.?|versus|v|with|or|against)\b|[,&/;+]/gi;
const FILLER =
  /\b(?:compare|comparing|comparison|congestion|congested|delays?|delayed|airports?|between|the|levels?|metrics?|how|does|do|is|are|more|less|than|which|expansion|unmet|demand|on|in|for|at|please|use|which|one|ones|worse|better|higher|lower|bigger|smaller|busier|busiest|stack|up)\b/gi;

const US_STATE_LIST = (
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU"
).split(" ");
const US_STATE_CODES = new Set(US_STATE_LIST);

/**
 * Marks "Portland, OR" so the state code is not read as the separator "or" or as a second place.
 * The code is stored as a number (its index in the list) so no letters can match a separator word.
 */
const STATE_MARK = "@@";
/** "Portland, Oregon": a full state name after a comma (longest names first, so "North Carolina" beats "Carolina"). */
const STATE_NAME_AFTER_COMMA = new RegExp(
  ",\\s*(" + [...STATE_ROWS].sort((a, b) => b.name.length - a.name.length).map((r) => r.name.replace(/ /g, "\\s+")).join("|") + ")\\b",
  "gi",
);

const markStates = (text: string): string =>
  text
    .replace(STATE_NAME_AFTER_COMMA, (_whole, name: string) => {
      const row = STATE_ROWS.find((r) => r.name.toLowerCase() === name.toLowerCase().replace(/\s+/g, " "));
      return row ? ` ${STATE_MARK}${US_STATE_LIST.indexOf(row.code)}` : _whole;
    })
    // "Portland OR and Seattle": an upper-case code right after a word and before a separator or the end.
    .replace(/(?<=[A-Za-z]) ([A-Z]{2})(?=\s*$|\s*[,&/;+]|\s+(?:and|vs\.?|versus|v|with|or|against)\b)/g, (whole, code: string) =>
      US_STATE_CODES.has(code) ? ` ${STATE_MARK}${US_STATE_LIST.indexOf(code)}` : whole,
    )
    .replace(/,\s*([A-Za-z]{2})\b(?!\w)/g, (whole, code: string) =>
    US_STATE_CODES.has(code.toUpperCase()) ? ` ${STATE_MARK}${US_STATE_LIST.indexOf(code.toUpperCase())}` : whole,
  );

export const clean = (part: string): string =>
  part.replace(FILLER, " ").replace(/[^\p{L}\p{N}.' @-]/gu, " ").replace(/\s+/g, " ").trim().replace(/(?:\s*[.'-])+$/, "");

/** A city name matches an airport whose city string equals it or contains it as a component ("Dallas" in "Dallas-Fort Worth"). */
const cityComponents = (city: string): string[] => [city, ...city.split(/[-/,]/)].map((c) => c.trim().toLowerCase());

/** The airports in `text` when it names two or more specific airports; null when it should be read as an area. */
export function namedAirports(text: string | undefined): NamedAirports | null {
  const parts = markStates(collapseSpelledLetters(text ?? ""))
    .split(SEPARATORS)
    .map(clean)
    .filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const found: Airport[] = [];
  let viaCity = false;
  for (const raw of parts) {
    const [place, stateIndex] = raw.split(STATE_MARK).map((piece) => piece.trim());
    let state = stateIndex === undefined ? undefined : US_STATE_LIST[Number(stateIndex)];
    const byCode = /^[A-Za-z]{3}$/.test(place) && !state ? data.getAirport(place) : undefined;
    const candidates: Airport[] = byCode
      ? [byCode]
      : data
          .allAirports()
          .filter((a) => cityComponents(a.city).includes(place.toLowerCase()) && (!state || a.state === state));
    if (candidates.length === 0 && !state) {
      // "Portland Oregon": a trailing full state name qualifies the city.
      const tokens = place.split(" ");
      for (let k = 1; k <= 3 && k < tokens.length && candidates.length === 0; k++) {
        const tail = tokens.slice(-k).join(" ").toLowerCase();
        const head = tokens.slice(0, -k).join(" ").toLowerCase();
        const row = STATE_ROWS.find((r) => r.name.toLowerCase() === tail);
        if (!row) continue;
        const inState = data.allAirports().filter((a) => cityComponents(a.city).includes(head) && a.state === row.code);
        if (inState.length > 0) {
          candidates.push(...inState);
          state = row.code;
        }
      }
    }
    if (candidates.length === 0) return null; // not a specific airport: let the scope resolver read the whole text
    if (candidates.length > 1) return { kind: "ambiguous", part: state ? `${place}, ${state}` : place, candidates };
    if (!byCode) viaCity = true;
    found.push(candidates[0]);
  }
  const unique = found.filter((a, i) => found.findIndex((o) => o.iata === a.iata) === i);
  return { kind: "airports", airports: unique, parts, viaCity };
}
