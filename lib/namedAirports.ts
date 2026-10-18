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
  | { kind: "airports"; airports: Airport[]; parts: string[]; viaCity: boolean }
  | { kind: "ambiguous"; part: string; candidates: Airport[] };

const SEPARATORS = /\b(?:and|vs\.?|versus|v|with|or|against)\b|[,&/;+]/gi;
const FILLER =
  /\b(?:compare|comparing|comparison|congestion|congested|delays?|delayed|airports?|between|the|levels?|metrics?|how|does|do|is|are|more|less|than|which|expansion|unmet|demand)\b/gi;

const US_STATE_LIST = (
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU"
).split(" ");
const US_STATE_CODES = new Set(US_STATE_LIST);

/**
 * Marks "Portland, OR" so the state code is not read as the separator "or" or as a second place.
 * The code is stored as a number (its index in the list) so no letters can match a separator word.
 */
const STATE_MARK = "@@";
const markStates = (text: string): string =>
  text.replace(/,\s*([A-Za-z]{2})\b(?!\w)/g, (whole, code: string) =>
    US_STATE_CODES.has(code.toUpperCase()) ? ` ${STATE_MARK}${US_STATE_LIST.indexOf(code.toUpperCase())}` : whole,
  );

export const clean = (part: string): string =>
  part.replace(FILLER, " ").replace(/[^\p{L}\p{N}.' @-]/gu, " ").replace(/\s+/g, " ").trim();

/** A city name matches an airport whose city string equals it or contains it as a component ("Dallas" in "Dallas-Fort Worth"). */
const cityComponents = (city: string): string[] => [city, ...city.split(/[-/,]/)].map((c) => c.trim().toLowerCase());

/** The airports in `text` when it names two or more specific airports; null when it should be read as an area. */
export function namedAirports(text: string | undefined): NamedAirports | null {
  const parts = markStates(text ?? "")
    .split(SEPARATORS)
    .map(clean)
    .filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const found: Airport[] = [];
  let viaCity = false;
  for (const raw of parts) {
    const [place, stateIndex] = raw.split(STATE_MARK).map((piece) => piece.trim());
    const state = stateIndex === undefined ? undefined : US_STATE_LIST[Number(stateIndex)];
    const byCode = /^[A-Za-z]{3}$/.test(place) && !state ? data.getAirport(place) : undefined;
    const candidates = byCode
      ? [byCode]
      : data
          .allAirports()
          .filter((a) => cityComponents(a.city).includes(place.toLowerCase()) && (!state || a.state === state));
    if (candidates.length === 0) return null; // not a specific airport: let the scope resolver read the whole text
    if (candidates.length > 1) return { kind: "ambiguous", part: state ? `${place}, ${state}` : place, candidates };
    if (!byCode) viaCity = true;
    found.push(candidates[0]);
  }
  const unique = found.filter((a, i) => found.findIndex((o) => o.iata === a.iata) === i);
  return { kind: "airports", airports: unique, parts, viaCity };
}
