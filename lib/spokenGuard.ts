/**
 * Guard for the voice line the model writes. Pure and deterministic: no I/O, no model.
 *
 * The model decides how to say it; this code decides whether it may be said. A line passes only
 * if every number in it matches a figure from this turn's tool results (after rounding at the
 * precision it was spoken with), every proper name is traceable to the tool results, the
 * conversation or the user's own words, it carries a hedge wherever a result was unavailable,
 * thin or capped, and it is short, plain text. Anything doubtful fails: the caller then speaks
 * the code-built template instead, so a failure costs naturalness, never correctness.
 *
 * Rounding rule: a spoken value v with precision p (the place of its last stated digit; "4.5
 * million" has p = 100,000, "five million" has p = 1,000,000) is grounded by a fact f when
 * |f - v| <= p / 2. So "13 percent" matches 12.8, "about five million" matches 4,501,620, and
 * "four million" does not.
 */

import { splitIntoSentences } from "./sentences";

export interface GuardInput {
  spoken: string;
  /** This turn's tool outputs: `ToolOutput` objects or bare result objects. Only result and table data count as facts. */
  toolOutputs: readonly unknown[];
  /** Text of earlier turns (replies, "shown on screen" notes), so a follow-up may refer back. */
  priorContext?: string | readonly string[];
  /** The user's latest message: names and numbers they said themselves may be repeated. */
  userWords?: string;
  /** Extra numbers that are true of the whole app (for example the airport count). */
  staticFacts?: readonly number[];
  /** Every airport, city and carrier name in the dataset, to catch a real but irrelevant name. */
  knownNames?: readonly string[];
}

export interface GuardVerdict {
  ok: boolean;
  /** The cleaned line when ok; always "" when not, so a rejected line cannot be spoken by mistake. */
  spoken: string;
  reasons: string[];
}

const MAX_CHARS = 300;
const MAX_SENTENCES = 3;
const MAX_CONTEXT_CHARS = 20_000;
const FRACTION_TOLERANCE = 0.1; // "one in five" matches 18 to 22 percent, "half" 45 to 55

// --------------------------------------------------------------------------- //
// Numbers in spoken text
// --------------------------------------------------------------------------- //

export type SpokenDirection = "up" | "down";

export interface SpokenNumber {
  /** The words or digits as spoken, for reasons. */
  text: string;
  value: number;
  /** Size of the last stated digit: the value is grounded within place / 2. */
  place: number;
  /** "one in five", "half": matched as a percentage within FRACTION_TOLERANCE. */
  fraction?: boolean;
  /** Said as a percentage ("12 percent", "12%"). A percent never matches a plain figure, and the reverse. */
  percent?: boolean;
  /** A word like up/down/fell/higher beside the figure: the fact's sign has to agree with it. */
  direction?: SpokenDirection;
  /** Followed by a thing being counted ("six runways"): the only place a count may be grounded. */
  countNoun?: string;
  /** Followed by a unit of measure ("2025 minutes"): then it is a measurement, not a year. */
  measureAfter?: boolean;
  /** After top/first/number/rank ("the top three", "number two"): a rank or list length, not a measure. */
  rankContext?: boolean;
  /** A figure that cannot be checked at all ("a few thousand"): always rejected. */
  unverifiable?: boolean;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MAGNITUDES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
// "12k", "4.5m", "2bn": digits followed by an abbreviated magnitude are scaled before they are checked.
const MAGNITUDE_ABBREVIATIONS: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, bn: 1e9, b: 1e9 };
const DENOMINATORS: Record<string, number> = {
  half: 2, halves: 2, third: 3, thirds: 3, quarter: 4, quarters: 4, fifth: 5, fifths: 5, tenth: 10, tenths: 10,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const ORDINAL_SUFFIXES = new Set(["st", "nd", "rd", "th"]);
// "one" is a number only before one of these ("one percent", "one in five"); otherwise it is the word "a".
const ONE_UNITS = new Set(["percent", "in", "hundred", "thousand", "million", "billion", "half"]);
// "a few thousand", "several million": a quantifier in front of a magnitude is a specific-sounding figure with no value.
const VAGUE_QUANTIFIERS = new Set(["few", "several", "couple", "dozens", "handful", "hundreds", "thousands", "millions"]);

const DIRECTION_UP = new Set(["up", "grew", "grow", "growing", "rose", "rise", "rising", "increased", "increase", "increasing", "gained", "gain", "higher", "more", "faster", "bigger", "larger", "jumped", "climbed", "added"]);
const DIRECTION_DOWN = new Set(["down", "fell", "fall", "falling", "dropped", "drop", "declined", "decline", "declining", "cut", "decreased", "decrease", "decreasing", "lost", "lose", "lower", "less", "fewer", "slower", "smaller", "shrank", "shrinking", "slipped", "slid"]);
// Things a count is a count of. A count anywhere else is not grounded by an array length.
const COUNT_NOUNS = new Set(["airport", "airports", "route", "routes", "carrier", "carriers", "airline", "airlines", "destination", "destinations", "row", "rows", "result", "results", "city", "cities", "runway", "runways", "option", "options", "aircraft"]);
const MEASURE_NOUNS = new Set(["minute", "minutes", "passenger", "passengers", "flight", "flights", "seat", "seats", "departure", "departures", "feet", "foot", "miles", "mile", "knots", "people", "hours", "delays", "percent"]);
const RANK_BEFORE = new Set(["top", "first", "last", "next", "bottom", "number", "no", "rank", "ranked"]);

const isNumberWord = (word: string | undefined): boolean =>
  word !== undefined && (word in UNITS || word in TENS);

/** The place of the last stated digit of a plain integer or decimal as written. */
function digitPlace(raw: string, value: number): number {
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  if (decimals > 0) return 10 ** -decimals;
  if (value < 1000) return 1;
  const trailingZeros = String(Math.round(value)).match(/0*$/)?.[0].length ?? 0;
  return 10 ** trailingZeros;
}

interface Token {
  text: string;
  digits: boolean;
  start: number;
  end: number;
}

interface Tokens {
  list: Token[];
  /** The lowercased text the offsets refer to, so punctuation between tokens can be seen. */
  source: string;
}

function tokenise(text: string): Tokens {
  const source = text.toLowerCase().replace(/[’]/g, "'").replace(/([a-z])-([a-z])/g, "$1 $2");
  const list: Token[] = [];
  for (const match of source.matchAll(/(\d[\d,]*(?:\.\d+)?)|([a-z]+)|(%)/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[1]) list.push({ text: match[1].replace(/,/g, ""), digits: true, start, end });
    else list.push({ text: match[3] ? "percent" : match[2], digits: false, start, end });
  }
  return { list, source };
}

type Kind = "none" | "unit" | "tens" | "hundred" | "magnitude";

/** Parse spoken number words starting at `start` ("twenty five", "four thousand five hundred", "four point nine"). */
function parseWords(tokens: Token[], start: number): { value: number; place: number; end: number } | null {
  let total = 0;
  let current = 0;
  let place = 1;
  let kind: Kind = "none";
  let i = start;

  for (; i < tokens.length; i++) {
    const word = tokens[i].digits ? "" : tokens[i].text;
    if (word in UNITS) {
      const small = UNITS[word] < 10;
      const allowed = kind === "none" || kind === "hundred" || kind === "magnitude" || (kind === "tens" && small);
      if (!allowed) break;
      current += UNITS[word];
      kind = "unit";
    } else if (word in TENS) {
      if (kind !== "none" && kind !== "hundred" && kind !== "magnitude") break;
      current += TENS[word];
      kind = "tens";
    } else if (word === "hundred") {
      if (kind !== "none" && kind !== "unit") break;
      current = (current || 1) * 100;
      place = 100;
      kind = "hundred";
    } else if (word in MAGNITUDES) {
      if (kind === "magnitude") break;
      total += (current || 1) * MAGNITUDES[word];
      current = 0;
      place = MAGNITUDES[word];
      kind = "magnitude";
    } else if (word === "and" && (kind === "hundred" || kind === "magnitude") && isNumberWord(tokens[i + 1]?.text)) {
      continue;
    } else {
      break;
    }
  }
  if (kind === "none") return null;
  let value = total + current;
  let resultPlace = kind === "hundred" || kind === "magnitude" ? place : 1;

  // "four point nine": decimal digits spoken one by one.
  if (tokens[i]?.text === "point" && !tokens[i].digits) {
    let digits = "";
    let j = i + 1;
    while (j < tokens.length && !tokens[j].digits && tokens[j].text in UNITS && UNITS[tokens[j].text] < 10) {
      digits += UNITS[tokens[j].text];
      j += 1;
    }
    if (digits) {
      value += Number(digits) / 10 ** digits.length;
      resultPlace = 10 ** -digits.length;
      i = j;
    }
  }
  return { value, place: resultPlace, end: i };
}

/** "twenty twenty five" or "nineteen ninety nine": a year spoken in two halves. */
function parseSpokenYear(tokens: Token[], start: number): { value: number; end: number } | null {
  const first = tokens[start]?.text;
  if (first !== "nineteen" && first !== "twenty") return null;
  const second = tokens[start + 1]?.text;
  if (!(second in TENS) && !(second in UNITS && UNITS[second] >= 10)) return null;
  let value = (first === "nineteen" ? 19 : 20) * 100 + (TENS[second] ?? UNITS[second]);
  let end = start + 2;
  const third = tokens[end]?.text;
  if (second in TENS && third in UNITS && UNITS[third] < 10 && UNITS[third] > 0) {
    value += UNITS[third];
    end += 1;
  }
  return { value, end };
}

/** True when punctuation (a comma, full stop...) sits between two tokens: a clause boundary. */
const breaksBetween = (tokens: Tokens, left: Token, right: Token): boolean => /[,.;:!?]/.test(tokens.source.slice(left.end, right.start));

/** The unit, direction and counting context around the tokens [start, end) of one figure. */
function annotate(tokens: Tokens, start: number, end: number): Pick<SpokenNumber, "percent" | "direction" | "countNoun" | "rankContext" | "measureAfter"> {
  const list = tokens.list;
  const wordAt = (i: number): string => (list[i] && !list[i].digits ? list[i].text : "");
  const percent = wordAt(end) === "percent";
  const afterStart = percent ? end + 1 : end;

  // Words after the figure, inside the same clause.
  const after: string[] = [];
  for (let i = afterStart; i < Math.min(list.length, afterStart + 2); i++) {
    const previous = i === afterStart ? list[end - 1] : list[i - 1];
    if (breaksBetween(tokens, previous, list[i])) break;
    after.push(wordAt(i));
  }
  // Words before the figure, inside the same clause, nearest first.
  const before: string[] = [];
  for (let i = start - 1; i >= Math.max(0, start - 3); i--) {
    if (breaksBetween(tokens, list[i], list[i + 1])) break;
    before.push(wordAt(i));
  }

  const nearest = [...before, ...after];
  const direction = nearest.map((w) => (DIRECTION_UP.has(w) ? "up" : DIRECTION_DOWN.has(w) ? "down" : null)).find((d) => d !== null) ?? undefined;
  return {
    percent: percent || undefined,
    direction: direction as SpokenDirection | undefined,
    countNoun: after.find((w) => COUNT_NOUNS.has(w)),
    rankContext: RANK_BEFORE.has(before[0] ?? "") || undefined,
    measureAfter: after.some((w) => MEASURE_NOUNS.has(w)) || undefined,
  };
}

/** Every number a listener would hear, with the precision it was spoken at. Exempt words are skipped. */
export function extractNumbers(text: string, ordinalLimit = 3): SpokenNumber[] {
  const tokens = tokenise(text);
  const list = tokens.list;
  const found: SpokenNumber[] = [];
  const word = (i: number): string => (list[i] && !list[i].digits ? list[i].text : "");
  const emit = (number: SpokenNumber, from: number, to: number): void => {
    found.push({ ...annotate(tokens, from, to), ...number });
  };

  for (let i = 0; i < list.length; ) {
    const token = list[i];

    // Ordinal words: "the second one" is an index, not a figure.
    if (!token.digits && token.text in ORDINALS && word(i + 1) !== "of") {
      if (ORDINALS[token.text] > ordinalLimit) emit({ text: token.text, value: ORDINALS[token.text], place: 1 }, i, i + 1);
      i += 1;
      continue;
    }

    // "a few thousand", "several million": no checkable value, so no licence for a figure.
    if (VAGUE_QUANTIFIERS.has(word(i)) && (word(i + 1) in MAGNITUDES || (word(i + 1) === "of" && word(i + 2) in MAGNITUDES))) {
      const magnitudeAt = word(i + 1) in MAGNITUDES ? i + 1 : i + 2;
      emit({ text: `${word(i)} ${word(magnitudeAt)}`, value: Number.NaN, place: 1, unverifiable: true }, i, magnitudeAt + 1);
      i = magnitudeAt + 1;
      continue;
    }

    // "half a million": a magnitude of its own.
    if (word(i) === "half" && word(i + 1) === "a" && word(i + 2) in MAGNITUDES) {
      const magnitude = MAGNITUDES[word(i + 2)];
      emit({ text: "half a " + word(i + 2), value: 0.5 * magnitude, place: magnitude / 10 }, i, i + 3);
      i += 3;
      continue;
    }

    // "a dozen", "two dozen"
    if ((word(i) === "a" || word(i) === "an") && word(i + 1) === "dozen") {
      emit({ text: "a dozen", value: 12, place: 1 }, i, i + 2);
      i += 2;
      continue;
    }

    // "a quarter", "a third", "two thirds", bare "half": a share, matched as a percentage.
    const shareNumerator = word(i) === "a" || word(i) === "an" ? 1 : isNumberWord(word(i)) ? UNITS[word(i)] ?? TENS[word(i)] : null;
    if (shareNumerator !== null && word(i + 1) in DENOMINATORS) {
      const denominator = DENOMINATORS[word(i + 1)];
      emit({ text: `${word(i)} ${word(i + 1)}`, value: (100 * shareNumerator) / denominator, place: 1, fraction: true }, i, i + 2);
      i += 2;
      continue;
    }
    if (word(i) === "half" && !(word(i + 1) in MAGNITUDES)) {
      emit({ text: "half", value: 50, place: 1, fraction: true }, i, i + 1);
      i += 1;
      continue;
    }

    // "a hundred", "a million"
    if ((word(i) === "a" || word(i) === "an") && word(i + 1) in MAGNITUDES) {
      const magnitude = MAGNITUDES[word(i + 1)];
      emit({ text: `a ${word(i + 1)}`, value: magnitude, place: magnitude }, i, i + 2);
      i += 2;
      continue;
    }

    if (token.digits) {
      const base = Number(token.text);
      if (Number.isNaN(base)) {
        i += 1;
        continue;
      }
      const suffix = word(i + 1);
      if (ORDINAL_SUFFIXES.has(suffix)) {
        if (base > ordinalLimit) emit({ text: `${token.text}${suffix}`, value: base, place: 1 }, i, i + 2);
        i += 2;
        continue;
      }
      // "1 in 5"
      if (suffix === "in" && list[i + 2]?.digits) {
        emit({ text: `${token.text} in ${list[i + 2].text}`, value: (100 * base) / Number(list[i + 2].text), place: 1, fraction: true }, i, i + 3);
        i += 3;
        continue;
      }
      if (suffix === "dozen") {
        emit({ text: `${token.text} dozen`, value: base * 12, place: 1 }, i, i + 2);
        i += 2;
        continue;
      }
      const magnitude = MAGNITUDES[suffix] ?? MAGNITUDE_ABBREVIATIONS[suffix];
      if (magnitude !== undefined) {
        emit({ text: `${token.text} ${suffix}`, value: base * magnitude, place: digitPlaceForMagnitude(token.text, base) * magnitude }, i, i + 2);
        i += 2;
        continue;
      }
      emit({ text: token.text, value: base, place: digitPlace(token.text, base) }, i, i + 1);
      i += 1;
      continue;
    }

    if (!token.digits) {
      const year = parseSpokenYear(list, i);
      if (year) {
        emit({ text: list.slice(i, year.end).map((t) => t.text).join(" "), value: year.value, place: 1 }, i, year.end);
        i = year.end;
        continue;
      }
    }

    if (isNumberWord(token.text) || token.text === "hundred") {
      const parsed = parseWords(list, i);
      if (!parsed) {
        i += 1;
        continue;
      }
      let { value, place } = parsed;
      let end = parsed.end;
      const spokenText = list.slice(i, end).map((t) => t.text).join(" ");

      // "one in five"
      if (word(end) === "in" && isNumberWord(word(end + 1))) {
        const denominator = parseWords(list, end + 1);
        if (denominator && denominator.value > 0) {
          emit({ text: `${spokenText} in ${list.slice(end + 1, denominator.end).map((t) => t.text).join(" ")}`, value: (100 * value) / denominator.value, place: 1, fraction: true }, i, denominator.end);
          i = denominator.end;
          continue;
        }
      }
      // "four and a half million"
      if (word(end) === "and" && word(end + 1) === "a" && word(end + 2) === "half") {
        const magnitude = MAGNITUDES[word(end + 3)];
        const unit = magnitude ?? 1;
        value = (value + 0.5) * unit;
        place = 0.5 * unit;
        end += magnitude ? 4 : 3;
        emit({ text: `${spokenText} and a half`, value, place }, i, end);
        i = end;
        continue;
      }
      // "five million" and "four point nine million": the magnitude word after a bare number
      if (word(end) in MAGNITUDES && (parsed.place === 1 || parsed.place < 1)) {
        const magnitude = MAGNITUDES[word(end)];
        value *= magnitude;
        place = parsed.place * magnitude;
        end += 1;
      } else if (word(end) === "dozen") {
        value *= 12;
        place = 1;
        end += 1;
      }
      // "one" on its own is an article; only "one percent", "one in five" and the like are figures
      if (spokenText === "one" && !ONE_UNITS.has(word(end))) {
        i = end;
        continue;
      }
      emit({ text: list.slice(i, end).map((t) => t.text).join(" "), value, place }, i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return found;
}

/** "4.5 million" is precise to 0.1 million; "21 million" to 1 million. */
function digitPlaceForMagnitude(raw: string, base: number): number {
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  return decimals > 0 ? 10 ** -decimals : base >= 1000 ? digitPlace(raw, base) : 1;
}

// --------------------------------------------------------------------------- //
// Grounding facts from the turn
// --------------------------------------------------------------------------- //

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "Washington", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana",
  IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// Keys whose contents are lists of everything the dataset has, or numbers that are not facts about the answer.
const IGNORED_KEYS = new Set(["known_airports", "valid_scopes", "valid_metrics", "valid_years", "valid_sort_by", "valid_group_by", "explain", "rank", "columns"]);
const NUMERIC_STRING = /^[+\-−]?\d[\d,]*(?:\.\d+)?%?$/;
// Fields that count things (rows returned, airports matched). They only ground a count said next to a counted noun.
const COUNT_KEYS = new Set([
  "returned", "row_count", "airports_matched", "airports_returned", "requested_top_n", "airport_count", "groups_with_increase",
  "groups_with_cut", "carrier_count", "runway_count", "airports_with_active_programs_nationwide", "forecast_periods",
]);
const YEAR_KEYS = new Set(["year", "data_year", "prior", "current"]);
const PERCENT_HEADER = /%|percent|share|yoy|growth|load factor|delayed|cancel/i;

/**
 * What a fact is, because it decides how it may be spoken:
 *  - percent: already a percentage (12.8 for 12.8%), spoken as "percent"
 *  - ratio:   a 0-1 fraction (0.82), spoken as a percentage ("82 percent") or as the ratio
 *  - count:   how many of something (3 airports), spoken only next to the noun or a rank word
 *  - year:    a calendar year
 *  - plain:   anything else (minutes, passengers, feet)
 *  - any:     a number the user or an earlier turn already said: may be repeated in any form
 */
export type FactKind = "percent" | "ratio" | "count" | "year" | "plain" | "any";

export interface Fact {
  /** Signed: a decline is negative, and "down" has to agree with that. */
  value: number;
  kind: FactKind;
  /** For a count: what it counts. "12 airlines" must not be grounded by 12 airports. Absent means any counted noun. */
  nouns?: ReadonlySet<string>;
}

const AIRPORT_NOUNS: ReadonlySet<string> = new Set(["airport", "airports", "city", "cities"]);
const CARRIER_NOUNS: ReadonlySet<string> = new Set(["carrier", "carriers", "airline", "airlines"]);
const ROUTE_NOUNS: ReadonlySet<string> = new Set(["route", "routes", "destination", "destinations"]);
const RUNWAY_NOUNS: ReadonlySet<string> = new Set(["runway", "runways"]);

/** What a counting field counts, from its name. Unknown fields may be a count of anything. */
function nounsForKey(key: string): ReadonlySet<string> | undefined {
  if (/airport|ranking|comparison|cit(?:y|ies)/i.test(key)) return AIRPORT_NOUNS;
  if (/carrier|airline/i.test(key)) return CARRIER_NOUNS;
  if (/route/i.test(key)) return ROUTE_NOUNS;
  if (/runway/i.test(key)) return RUNWAY_NOUNS;
  return undefined;
}

interface Flags {
  unavailable: boolean;
  insufficient: boolean;
  truncated: boolean;
  noService: boolean;
  ambiguous: boolean;
  refusal: boolean;
}

interface Grounding {
  facts: Fact[];
  /** Two-letter capitals seen in the results ("OR", "ME"): they license the full state name. */
  stateCodes: Set<string>;
  words: Set<string>;
  arrayMax: number;
  flags: Flags;
  /** Every tool result was an error or unavailable: nothing numeric may be spoken. */
  nothingUsable: boolean;
}

const wordsOf = (text: string): string[] =>
  (text.toLowerCase().replace(/[’]/g, "'").match(/[a-z]+(?:'[a-z]+)?/g) ?? []).map((w) => w.replace(/'s$/, ""));

function kindOfKey(key: string, value: number): FactKind {
  if (YEAR_KEYS.has(key) && Number.isInteger(value) && value >= 1900 && value <= 2100) return "year";
  if (/pct|percent/i.test(key)) return "percent";
  if (COUNT_KEYS.has(key)) return "count";
  if (!Number.isInteger(value) && Math.abs(value) <= 1) return "ratio";
  return "plain";
}

function addNumberFact(grounding: Grounding, value: number, kind: FactKind, key = ""): void {
  if (Number.isFinite(value)) grounding.facts.push(kind === "count" ? { value, kind, nouns: nounsForKey(key) } : { value, kind });
}

function addStringFact(grounding: Grounding, raw: string, header: string | undefined): void {
  const text = raw.trim();
  if (!NUMERIC_STRING.test(text)) return;
  const value = Number(text.replace(/[%,+]/g, "").replace("−", "-"));
  const percent = text.endsWith("%") || (header !== undefined && PERCENT_HEADER.test(header));
  addNumberFact(grounding, value, percent ? "percent" : "plain");
}

/** A table: cells are read by column, so the Rank column is not a fact and a share column is a percent. */
function walkTable(columns: unknown[], rows: unknown[], grounding: Grounding): void {
  grounding.facts.push({ value: rows.length, kind: "count" });
  grounding.arrayMax = Math.max(grounding.arrayMax, rows.length);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    row.forEach((cell, index) => {
      const header = typeof columns[index] === "string" ? (columns[index] as string) : undefined;
      if (header && /^rank$/i.test(header)) return;
      if (typeof cell === "number") addNumberFact(grounding, cell, header && PERCENT_HEADER.test(header) ? "percent" : "plain");
      else if (typeof cell === "string") {
        addStringFact(grounding, cell, header);
        for (const w of wordsOf(cell)) grounding.words.add(w);
        for (const code of cell.match(/\b[A-Z]{2}\b/g) ?? []) grounding.stateCodes.add(code);
        for (const year of cell.match(/\b(?:19|20)\d\d\b/g) ?? []) addNumberFact(grounding, Number(year), "year");
        if (cell === "insufficient data") grounding.flags.insufficient = true;
      }
    });
  }
}

function walk(value: unknown, grounding: Grounding, key = ""): void {
  if (IGNORED_KEYS.has(key)) return;
  if (typeof value === "number") {
    addNumberFact(grounding, value, kindOfKey(key, value), key);
  } else if (typeof value === "string") {
    addStringFact(grounding, value, undefined);
    for (const year of value.match(/\b(?:19|20)\d\d\b/g) ?? []) addNumberFact(grounding, Number(year), "year");
    for (const w of wordsOf(value)) grounding.words.add(w);
    for (const code of value.match(/\b[A-Z]{2}\b/g) ?? []) grounding.stateCodes.add(code);
    if (value === "insufficient data") grounding.flags.insufficient = true;
  } else if (Array.isArray(value)) {
    grounding.facts.push({ value: value.length, kind: "count", nouns: nounsForKey(key) });
    grounding.arrayMax = Math.max(grounding.arrayMax, value.length);
    for (const item of value) walk(item, grounding, key);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.columns) && Array.isArray(record.rows)) {
      walkTable(record.columns, record.rows, grounding);
      if (typeof record.caption === "string") for (const w of wordsOf(record.caption)) grounding.words.add(w);
      return;
    }
    for (const [k, v] of Object.entries(record)) {
      if (IGNORED_KEYS.has(k)) continue;
      if (k === "available" && v === false) grounding.flags.unavailable = true;
      if (k === "do_not_estimate" && v === true) grounding.flags.unavailable = true;
      if (k === "no_service" && v === true) grounding.flags.noService = true;
      if (k === "truncated" && v === true) grounding.flags.truncated = true;
      if (k === "status" && v === "ambiguous") grounding.flags.ambiguous = true;
      if (k === "unscored" && Array.isArray(v) && v.length > 0) grounding.flags.insufficient = true;
      if (k === "insufficient_data" && v) grounding.flags.insufficient = true;
      walk(v, grounding, k);
    }
  }
}

/** A ToolOutput contributes its result and table; its assumptions and caveat text are not facts about the answer. */
function factSources(output: unknown): unknown[] {
  if (output && typeof output === "object" && "result" in output) {
    const { result, structured } = output as { result: unknown; structured?: unknown };
    return [result, structured].filter((part) => part != null);
  }
  return [output];
}

function isErrorResult(output: unknown): boolean {
  const result = output && typeof output === "object" && "result" in output ? (output as { result: unknown }).result : output;
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return typeof r.error === "string" || r.available === false || r.do_not_estimate === true;
}

export function collectGrounding(outputs: readonly unknown[]): Grounding {
  const grounding: Grounding = {
    facts: [],
    stateCodes: new Set(),
    words: new Set(),
    arrayMax: 0,
    flags: { unavailable: false, insufficient: false, truncated: false, noService: false, ambiguous: false, refusal: false },
    nothingUsable: false,
  };
  for (const output of outputs) for (const source of factSources(output)) walk(source, grounding);

  for (const output of outputs) {
    const result = output && typeof output === "object" && "result" in output ? (output as { result: unknown }).result : output;
    if (result && typeof result === "object" && typeof (result as Record<string, unknown>).error === "string") grounding.flags.refusal = true;
  }
  grounding.nothingUsable = outputs.length > 0 && outputs.every(isErrorResult);
  // The tools say "OR" and "ME"; people say Oregon and Maine. A code in the results licenses its name.
  for (const code of grounding.stateCodes) for (const w of wordsOf(STATE_NAMES[code] ?? "")) grounding.words.add(w);
  return grounding;
}

// --------------------------------------------------------------------------- //
// Checks
// --------------------------------------------------------------------------- //

const isYearValue = (n: SpokenNumber): boolean => Number.isInteger(n.value) && n.value >= 1900 && n.value <= 2100;

/** Does this fact say what the speech says, in the way the speech says it? */
function factSupports(spoken: SpokenNumber, fact: Fact): boolean {
  const magnitude = Math.abs(fact.value);
  const slack = 1e-9 * Math.max(1, spoken.place);
  const within = (candidate: number): boolean => Math.abs(candidate - spoken.value) <= spoken.place / 2 + slack;
  const near = (candidate: number): boolean => candidate > 0 && Math.abs(candidate - spoken.value) <= FRACTION_TOLERANCE * spoken.value;

  if (fact.kind === "any") return spoken.fraction ? near(magnitude) : within(magnitude) || within(magnitude * 100);

  // A share ("one in five", "a third of") is a percentage: it can only come from a percent or a ratio.
  if (spoken.fraction) {
    if (fact.kind === "percent") return near(magnitude);
    if (fact.kind === "ratio") return near(magnitude * 100);
    return false;
  }
  // Said as a percentage: a percent, or a ratio times 100. Never a minute count, a passenger count or a score.
  if (spoken.percent) {
    if (fact.kind === "percent") return within(magnitude) && signAgrees(spoken, fact);
    if (fact.kind === "ratio") return within(magnitude * 100) && signAgrees(spoken, fact);
    return false;
  }
  // Said as a plain figure.
  switch (fact.kind) {
    case "plain":
      return within(magnitude) && signAgrees(spoken, fact);
    case "ratio":
      return within(magnitude); // "a load factor of 0.82": the ratio itself, never times 100 without the word percent
    case "year":
      return isYearValue(spoken) && !spoken.measureAfter && within(magnitude);
    case "count":
      // A count is grounded only next to what is counted ("three airports"); a rank word ("the top
      // three", "number two") only needs the list to be that long. Anywhere else it is not a figure from the tool.
      return Boolean(spoken.countNoun) && (!fact.nouns || fact.nouns.has(spoken.countNoun as string)) && within(magnitude);
    default:
      return false;
  }
}

/** "Down 4.7 percent" is only true of a fact that is negative; "up", of one that is positive. */
function signAgrees(spoken: SpokenNumber, fact: Fact): boolean {
  if (!spoken.direction || fact.value === 0 || isYearValue(spoken)) return true;
  return spoken.direction === "up" ? fact.value > 0 : fact.value < 0;
}

function groundedIn(spoken: SpokenNumber, facts: readonly Fact[], listLength: number): boolean {
  if (spoken.unverifiable || Number.isNaN(spoken.value)) return false;
  if (spoken.rankContext && !spoken.percent && Number.isInteger(spoken.value) && spoken.value >= 1 && spoken.value <= listLength) return true;
  return facts.some((fact) => factSupports(spoken, fact));
}

const MARKDOWN = /[*#_`|[\]<>~]/;
const LIST_MARKER = /^\s*(?:[-•*]|\d+[.)])\s/m;
const URL = /https?:|www\./i;
const EMOJI = /[\p{Extended_Pictographic}️‍]/u;
const NUMBER_WORD = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many|few|couple)";
// Claims the model computed ("three times faster", "half as big", "doubled"): no tool returned them.
const DERIVED_CLAIM = new RegExp(
  [
    "\\b(?:twice|double[sd]?|triple[sd]?|tripled|quadrupl\\w*|halved?|halving)\\b",
    `\\b${NUMBER_WORD}\\s+times\\b`,
    "\\b\\d+(?:\\.\\d+)?\\s*x\\b",
    `\\b(?:two|three|four|five|ten|several|many|\\d+)[ -]?fold\\b`,
    "\\b(?:half|a third|a quarter|one third|one quarter|two thirds|three quarters)\\s+(?:as|more|less|again)\\b",
  ].join("|"),
  "i",
);

function formatReasons(spoken: string): string[] {
  const reasons: string[] = [];
  if (!spoken.trim()) return ["format: empty"];
  if (spoken.length > MAX_CHARS) reasons.push(`format: longer than ${MAX_CHARS} characters`);
  if (/\n/.test(spoken)) reasons.push("format: line break");
  if (MARKDOWN.test(spoken)) reasons.push("format: markdown or symbol");
  if (LIST_MARKER.test(spoken)) reasons.push("format: list marker");
  if (URL.test(spoken)) reasons.push("format: link");
  if (EMOJI.test(spoken)) reasons.push("format: emoji");
  if (splitIntoSentences(spoken).length > MAX_SENTENCES) reasons.push(`format: more than ${MAX_SENTENCES} sentences`);
  return reasons;
}

const ACRONYMS = new Set(["FAA", "BTS", "NOAA", "TAF", "METAR", "VFR", "IFR", "MVFR", "LIFR", "ADS", "DOT", "OK", "US", "UK", "AM", "PM", "TSA", "ATC", "NAS"]);
const CALENDAR = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
/**
 * Words that may start a sentence without being names. Anything else at the start of a sentence,
 * or any capitalised word in the middle, must be traceable. A legitimate word missing here only
 * costs a fallback to the template; add it after checking the fixtures, never by loosening a rule.
 */
export const COMMON_SENTENCE_STARTERS = new Set(
  (
    "a an the it its i i'm i've i'd i'll we we're you you're your they there here that this these those sure yes yeah no nope " +
    "okay ok right good great nice well so and but or if when while as at in on of for from to with by about around over under " +
    "after before since because today now last next this most more less few some many much all both each every only just still " +
    "also even though however my our their his her one two three let let's want would could should can can't cannot do don't " +
    "does doesn't did didn't is isn't are aren't was wasn't were what which who where why how not nothing nobody none maybe " +
    "probably honestly basically overall mostly usually typically looks seems appears got have has had hmm hey hi hello thanks " +
    "thank please sorry unfortunately luckily interesting traffic seats seat passengers passenger delays delay flights flight " +
    "demand routes route service capacity growth congestion weather wind visibility conditions runways runway data numbers " +
    "results result ranking rankings table table's score scores scoring airports airport carriers carrier cancellations " +
    "cancellation load factor live feed source sources snapshot dataset coverage region regions state states city cities " +
    "metro metros population nonstop direct short medium long haul departures departure arrivals arrival year years month " +
    "months week weeks day days time times yesterday tomorrow tonight morning evening currently recently lately while until " +
    "both either neither another other others same different bigger biggest larger largest smaller smallest higher highest " +
    "lower lowest better best worse worst fewer fewest slightly roughly nearly almost about approximately close closer closest " +
    "ahead behind then next finally first second third fourth fifth later earlier already yet again anything something " +
    "everything someone anyone everyone people nobody travelers travellers customers across among throughout " +
    "within near between despite outside inside along toward towards against beyond per"
  ).split(/\s+/),
);

function nameReasons(spoken: string, vocabulary: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  for (const sentence of splitIntoSentences(spoken)) {
    const tokens = sentence.replace(/[’]/g, "'").match(/[A-Za-z][A-Za-z']*/g) ?? [];

    // Spelled-out codes: "L A X" or "U.S." arrive as runs of single capital letters.
    let run = "";
    const flushRun = (): void => {
      if (run.length >= 2) {
        const code = run.toLowerCase();
        if (!vocabulary.has(code) && !ACRONYMS.has(run)) reasons.push(`name: ${run}`);
      }
      run = "";
    };

    tokens.forEach((raw, index) => {
      if (raw.length === 1 && /[A-Z]/.test(raw)) {
        run += raw;
        return;
      }
      flushRun();
      const token = raw.replace(/'s$/i, "");
      if (!/^[A-Z]/.test(token)) return;
      const lower = token.toLowerCase();
      if (token === "I" || /^I'(?:m|d|ll|ve)$/.test(raw)) return;
      if (ACRONYMS.has(token) || CALENDAR.has(lower)) return;
      if (vocabulary.has(lower)) return;
      if (index === 0 && COMMON_SENTENCE_STARTERS.has(lower)) return;
      if (index === 0 && COMMON_SENTENCE_STARTERS.has(raw.toLowerCase())) return;
      reasons.push(`name: ${token}`);
    });
    flushRun();
  }
  return [...new Set(reasons)];
}

/** A dataset name appearing in the line must be in this turn's vocabulary: no real-but-irrelevant airports. */
function knownNameReasons(spoken: string, knownNames: readonly string[], vocabulary: ReadonlySet<string>): string[] {
  const lowered = ` ${spoken.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  const reasons: string[] = [];
  for (const name of knownNames) {
    const words = wordsOf(name);
    if (words.length === 0 || !lowered.includes(` ${words.join(" ")} `)) continue;
    if (!words.every((w) => vocabulary.has(w))) reasons.push(`name: ${name} is not part of this answer`);
  }
  return reasons;
}

const HEDGES = {
  unavailable: ["can't", "cannot", "can not", "isn't", "is not", "aren't", "not responding", "not answering", "unavailable", "not available", "couldn't", "could not", "didn't", "don't have", "do not have", "not configured", "no live", "unable", "won't", "not working", "no data", "didn't answer"],
  insufficient: ["not enough", "too few", "can't score", "cannot score", "insufficient", "rather not guess", "isn't enough", "no reliable", "not reliable", "don't have enough", "doesn't have enough", "have enough", "too thin", "can't rate"],
  truncated: ["top", "biggest", "largest", "leading", "main", "most", "highest", "first", "busiest", "lowest", "some", "several", "few", "handful", "strongest", "leads", "among", "biggest cuts", "cut"],
  noService: ["no nonstop", "no scheduled", "no direct", "no service", "doesn't have", "does not have", "isn't served", "not served", "no flights", "no flight"],
  refusal: ["can't", "cannot", "couldn't", "could not", "don't have", "do not have", "only cover", "only have", "outside", "isn't in", "is not in", "not in", "didn't", "don't cover", "unable", "?", "no airports", "not recognized", "didn't recognise", "didn't recognize"],
} as const;

function hasHedge(spokenLower: string, hedges: readonly string[]): boolean {
  return hedges.some((hedge) => (hedge === "?" ? spokenLower.includes("?") : new RegExp(`(?:^|[^a-z])${hedge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z])`).test(spokenLower)));
}

function hedgeReasons(spoken: string, flags: Flags): string[] {
  const lower = spoken.toLowerCase().replace(/[’]/g, "'");
  const reasons: string[] = [];
  if (flags.unavailable && !hasHedge(lower, HEDGES.unavailable)) reasons.push("hedge missing: a source was unavailable");
  if (flags.insufficient && !hasHedge(lower, HEDGES.insufficient)) reasons.push("hedge missing: data was insufficient");
  if (flags.truncated && !hasHedge(lower, HEDGES.truncated)) reasons.push("hedge missing: the result was capped");
  if (flags.noService && !hasHedge(lower, HEDGES.noService)) reasons.push("hedge missing: no nonstop service");
  if (flags.ambiguous && !lower.includes("?")) reasons.push("hedge missing: an ambiguous place needs a question");
  if (flags.refusal && !hasHedge(lower, HEDGES.refusal)) reasons.push("hedge missing: the request could not be answered");
  return reasons;
}

const toList = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === "string" ? [value] : [...value];

/** Decide whether `spoken` may be voiced. Fail closed: any doubt is ok:false with a reason. */
export function guardSpoken(input: GuardInput): GuardVerdict {
  const reasons: string[] = [];
  const spoken = (input.spoken ?? "").replace(/\s+/g, " ").trim();
  reasons.push(...formatReasons(input.spoken ?? ""));

  const grounding = collectGrounding(input.toolOutputs);
  // Bounded so a huge history cannot make the check slow; the recent turns are what a follow-up refers to.
  const contextText = [...toList(input.priorContext), input.userWords ?? ""].join(" ").slice(-MAX_CONTEXT_CHARS);
  const ordinalLimit = Math.max(3, grounding.arrayMax);

  // Numbers the user or the conversation already put on the table may be repeated, in any form.
  const contextFacts: Fact[] = [
    ...extractNumbers(contextText, Number.POSITIVE_INFINITY).map((n) => ({ value: n.value, kind: "any" as const })),
    ...(contextText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((d) => ({ value: Number(d.replace(/,/g, "")), kind: "any" as const })),
    ...(input.staticFacts ?? []).map((value) => ({ value, kind: "any" as const })),
  ];
  const turnFacts = grounding.nothingUsable ? [] : grounding.facts;
  const facts = [...turnFacts, ...contextFacts];

  for (const number of extractNumbers(spoken, ordinalLimit)) {
    if (!groundedIn(number, facts, grounding.arrayMax)) reasons.push(`number: "${number.text}" is not in the tool results`);
  }
  if (DERIVED_CLAIM.test(spoken)) reasons.push("number: a computed comparison (times, twice, half as, doubled) is not in the tool results");

  const vocabulary = new Set<string>([...grounding.words, ...wordsOf(contextText)]);
  reasons.push(...nameReasons(spoken, vocabulary));
  if (input.knownNames) reasons.push(...knownNameReasons(spoken, input.knownNames, vocabulary));
  reasons.push(...hedgeReasons(spoken, grounding.flags));

  const ok = reasons.length === 0;
  return { ok, spoken: ok ? spoken : "", reasons };
}
