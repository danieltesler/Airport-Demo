/**
 * Spoken rendering: what the voice reads aloud when the model's own voice line is missing or
 * was rejected by lib/spokenGuard.ts ("template v2").
 *
 * It is built by code from the same structured table the user sees, so every figure it speaks is
 * a figure on screen, rounded the way a person would say it (and the way the guard accepts it).
 * One to two short sentences, contractions where natural, no "out of 100" jargon. A table kind
 * it does not know how to summarise returns null rather than reading rows aloud as nonsense.
 * Pure and deterministic: no I/O, no model.
 */

import { stripMarkdown } from "./markdown";
import { splitIntoSentences } from "./sentences";
import type { StructuredResult } from "./types";

// A reply with no table is read whole when it is short. 600 characters is about 35 seconds of
// speech and about 120 ElevenLabs Flash credits: beyond that the rest is left on screen.
const MAX_PROSE_CHARS = 600;
const MAX_CAVEAT_CHARS = 100;

const TITLE_WORDS: Record<string, string> = { Mr: "Mister", Mrs: "Missus", Ms: "Ms", Dr: "Doctor", Mt: "Mount" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Make text safe to hand to a TTS voice: the usual "it said it wrong" cases. */
export function normaliseForSpeech(text: string): string {
  return text
    // A parenthetical becomes its own comma-set clause, so the voice pauses around it
    // instead of running it into the sentence.
    .replace(/\s*\(([^()]*)\)/g, ", $1,")
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\bvs\./gi, "versus")
    .replace(/\b(Mr|Mrs|Ms|Dr|Mt)\./g, (_: string, title: string) => TITLE_WORDS[title])
    // Dotted initialisms (U.S., U.K., a.m.) are spelled out like airport codes: "U S".
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (initialism) => initialism.replace(/\./g, "").split("").join(" "))
    // "2025-05" is a month, not a range: said as "May 2025".
    .replace(/\b(20\d\d)-(0[1-9]|1[0-2])\b/g, (_: string, year: string, month: string) => `${MONTHS[Number(month) - 1]} ${year}`)
    .replace(/\bYoY\b/gi, "year over year")
    .replace(/%/g, " percent")
    .replace(/(^|[\s(])-(?=\d)/g, "$1minus ")
    .replace(/(\d)\s*-\s*(\d)/g, "$1 to $2")
    .replace(/</g, " under ")
    .replace(/>/g, " over ")
    .replace(/\bmin\b/gi, "minutes")
    .replace(/\bmi\b/gi, "miles")
    // Three capitals in a row is a code or acronym (LAX, GDS): spell it out. Kept as plain
    // text because it works on every voice model; ElevenLabs phoneme tags only work on
    // eleven_flash_v2, and a pronunciation dictionary is a separate resource to maintain.
    .replace(/\b[A-Z]{3}\b/g, (code) => code.split("").join(" "))
    .replace(/[()]/g, " ")
    .replace(/[/_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,(\s*,)+/g, ",")
    .replace(/,\s*([.;:!?])/g, "$1")
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

/** A spoken sentence always ends in punctuation, even after "U.S." lost its dots. */
function endWithPunctuation(sentence: string): string {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

const speakSentences = (sentences: string[]): string =>
  sentences
    .filter(Boolean)
    .map((sentence) => endWithPunctuation(normaliseForSpeech(sentence)))
    .join(" ");

/** The model's verified voice line, made ready for the voice (codes and abbreviations spelled out). */
export function speakableModelLine(line: string): string | null {
  const sentences = splitIntoSentences(line.replace(/\s+/g, " ").trim());
  return sentences.length > 0 ? speakSentences(sentences) : null;
}

// --------------------------------------------------------------------------- //
// Reading table cells
// --------------------------------------------------------------------------- //

type Row = StructuredResult["rows"][number];

const asNumber = (cell: unknown): number | null => {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== "string") return null;
  const value = parseFloat(cell.replace(/,/g, ""));
  return Number.isNaN(value) ? null : value;
};

const columnIndex = (data: StructuredResult, pattern: RegExp): number => data.columns.findIndex((c) => pattern.test(c));
const cellAt = (row: Row, index: number): unknown => (index >= 0 ? row[index] : undefined);
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Counts from zero to ten as words, larger as digits, the way people write them for speech. */
const countWord = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 10 ? SMALL_NUMBERS[n] : String(n));

/**
 * A figure the way a person says it, within the precision the guard checks: millions with at
 * most one decimal, thousands to three significant figures, small values to a whole number.
 */
function figure(value: number): string {
  const v = Math.abs(value);
  if (v >= 1e6) {
    const millions = v / 1e6;
    return `${Number((millions >= 100 ? Math.round(millions) : millions.toFixed(1)))} million`;
  }
  if (v >= 1000) {
    const magnitude = 10 ** (Math.floor(Math.log10(v)) - 2);
    return (Math.round(v / magnitude) * magnitude).toLocaleString("en-US");
  }
  return countWord(Math.round(v));
}

/** "about six percent", or null when the change is too small to say anything about. */
function percentPhrase(value: number): string | null {
  const v = Math.abs(value);
  if (v < 0.5) return null;
  const rounded = Math.round(v);
  return `${Number.isInteger(v) ? "" : "about "}${countWord(rounded)} percent`;
}

const AIRPORT_LABEL = /^([A-Z0-9]{3}) — (.+)$/;

/** "LAX — Los Angeles" -> city and code; any other label is spoken as it is. */
function parseAirportLabel(label: string): { code: string | null; city: string } {
  const match = label.match(AIRPORT_LABEL);
  return match ? { code: match[1], city: match[2] } : { code: null, city: label };
}

/**
 * Spoken names for a set of airport labels. The city is easier on the ear than a
 * code, but two airports in one city (JFK and LGA are both "New York") would be
 * indistinguishable, so those get their code appended.
 */
function spokenNames(labels: string[]): string[] {
  const parsed = labels.map(parseAirportLabel);
  return parsed.map(({ code, city }) => {
    const clash = parsed.filter((other) => other.city === city).length > 1;
    const name = city.replace(/-/g, " ").replace(/\//g, " ");
    return clash && code ? `${name} ${code}` : name;
  });
}

/** The first short sentence of the uncertainty, or null: the assumptions panel carries the rest. */
function shortCaveat(uncertainty: string | null | undefined): string | null {
  const sentence = uncertainty ? splitIntoSentences(uncertainty)[0] : undefined;
  return sentence && sentence.length <= MAX_CAVEAT_CHARS ? sentence : null;
}

function scopeFromCaption(caption: string | undefined): string {
  const scope = caption?.match(/^Scope: (.+?) ·/)?.[1]?.trim();
  if (!scope || /\d/.test(scope) || scope.length > 40 || /^(near|within)\b/i.test(scope)) return "";
  return scope.toLowerCase() === "all airports" ? "Across all airports, " : `In ${scope}, `;
}

const joinNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// --------------------------------------------------------------------------- //
// One summariser per table shape. Each returns sentences or null.
// --------------------------------------------------------------------------- //

type Summary = string[] | null;

function rankingSummary(data: StructuredResult, uncertainty: string | null | undefined): Summary {
  const rows = data.rows.filter((row) => asNumber(row[2]) !== null);
  if (rows.length === 0) return null;

  const top = rows.slice(0, 3);
  const names = spokenNames(top.map((row) => String(row[1])));
  const metric = (data.columns[2] ?? "").toLowerCase();
  const verb = /congestion/.test(metric)
    ? "is the most congested"
    : /unmet/.test(metric)
      ? "shows the most unmet demand"
      : /expansion/.test(metric)
        ? "looks strongest for expansion"
        : "leads";

  let detail = "";
  if (/congestion/.test(metric)) {
    const delay = asNumber(cellAt(top[0], columnIndex(data, /delay/i)));
    if (delay !== null && delay >= 0.5) detail = `, with delays averaging about ${countWord(Math.round(delay))} minutes`;
  } else {
    const growth = asNumber(cellAt(top[0], columnIndex(data, /growth/i)));
    const phrase = growth === null ? null : percentPhrase(growth);
    if (phrase && growth !== null) detail = `, with traffic ${growth >= 0 ? "up" : "down"} ${phrase}`;
  }

  const rest = names.slice(1);
  const first = `${scopeFromCaption(data.caption)}${names[0]} ${verb}${detail}${rest.length > 0 ? `, followed by ${joinNames(rest)}` : ""}.`;
  const caveat = shortCaveat(uncertainty);
  return caveat ? [upperFirst(first), caveat] : [upperFirst(first)];
}

function comparisonSummary(data: StructuredResult, uncertainty: string | null | undefined): Summary {
  const scored = data.rows.filter((row) => asNumber(row[1]) !== null);
  const unscored = data.rows.filter((row) => asNumber(row[1]) === null);
  const sentences: string[] = [];

  if (scored.length > 0) {
    const ranked = [...scored].sort((a, b) => (asNumber(b[1]) as number) - (asNumber(a[1]) as number));
    const names = spokenNames(ranked.map((row) => String(row[0])));
    const metric = (data.columns[1] ?? "score").toLowerCase().replace(/ score$/, "").replace(/-/g, " ");
    if (ranked.length === 1) {
      if (unscored.length === 0) sentences.push(`${names[0]} is the only airport in that comparison.`);
    } else if (Math.round(asNumber(ranked[0][1]) as number) === Math.round(asNumber(ranked[1][1]) as number)) {
      sentences.push(`${names[0]} and ${names[1]} are about level on ${metric}.`);
    } else {
      const delay = asNumber(cellAt(ranked[0], columnIndex(data, /delay/i)));
      const detail = /congestion/.test(metric) && delay !== null && delay >= 0.5 ? `, with delays averaging about ${countWord(Math.round(delay))} minutes` : "";
      const lead = /congestion/.test(metric)
        ? `${names[0]} is more congested than ${joinNames(names.slice(1))}`
        : `${names[0]} comes out ahead of ${joinNames(names.slice(1))} on ${metric}`;
      sentences.push(`${lead}${detail}.`);
    }
  }
  if (unscored.length > 0) {
    const names = spokenNames(unscored.map((row) => String(row[0])));
    sentences.push(`There isn't enough data to score ${joinNames(names)} fairly.`);
  }
  if (sentences.length === 0) return null;
  const caveat = shortCaveat(uncertainty);
  return caveat && sentences.length < 2 ? [...sentences, caveat] : sentences;
}

const HAUL_WORDS = new Set(["short", "medium", "long"]);

function breakdownSummary(data: StructuredResult): Summary {
  const shares = data.rows
    .map((row) => ({ label: String(row[0]), value: asNumber(row[1]) }))
    .filter((share): share is { label: string; value: number } => share.value !== null)
    .sort((a, b) => b.value - a.value);
  if (shares.length === 0) return null;

  const first = shares[0].label.split(/[\s(]/)[0].toLowerCase();
  const label = HAUL_WORDS.has(first) ? `${first} haul` : shares[0].label.replace(/\s*\(.*\)/, "").toLowerCase();
  const percent = percentPhrase(shares[0].value);
  if (!percent) return null;
  return [shares[0].value >= 50 ? `Most departures are ${label}, ${percent}.` : `The biggest share of departures is ${label}, ${percent}.`];
}

const TOP_ROUTE_LIMIT = 3;

function metricSummary(data: StructuredResult): Summary {
  const head = (data.columns[0] ?? "").toLowerCase();
  const rows = data.rows;
  const rowByLabel = (pattern: RegExp): Row | undefined => rows.find((row) => typeof row[0] === "string" && pattern.test(row[0]));

  if (/^driver/.test(head)) {
    const drivers = rows
      .map((row) => ({ label: String(row[0]).replace(/\s*\(.*\)/, "").replace(/-/g, " ").toLowerCase(), value: asNumber(row[1]) }))
      .filter((d): d is { label: string; value: number } => d.value !== null)
      .sort((a, b) => b.value - a.value);
    if (drivers.length === 0) return null;
    const second = drivers[1] ? `, followed by ${drivers[1].label}` : "";
    return [`${upperFirst(drivers[0].label)} is the biggest driver${second}.`];
  }

  if (head === "rank" && /^destination/i.test(data.columns[1] ?? "")) {
    const names = spokenNames(rows.slice(0, TOP_ROUTE_LIMIT).map((row) => String(row[1])));
    if (names.length === 0) return null;
    const rest = names.slice(1);
    return [`${names[0]} is the biggest route${rest.length > 0 ? `, followed by ${joinNames(rest)}` : ""}.`];
  }

  if (head === "carrier") {
    const share = asNumber(cellAt(rows[0] ?? [], columnIndex(data, /seat share/i)));
    const name = String(rows[0]?.[0] ?? "").replace(/\s*\([A-Z0-9]{2,3}\)\s*$/, "");
    const percent = share === null ? null : percentPhrase(share);
    return name && percent ? [`${name} has the biggest share, ${percent} of seats.`] : null;
  }

  if (head === "change") {
    const total = rowByLabel(/^total$/i);
    const change = asNumber(cellAt(total ?? [], columnIndex(data, /seat change \(%\)/i)));
    const years = [data.columns[2], data.columns[3]].map((c) => c?.match(/\d{4}/)?.[0]);
    const percent = change === null ? null : percentPhrase(change);
    if (!percent || !years[0] || !years[1] || change === null) return null;
    const cut = rowByLabel(/^cut$/i);
    const city = cut ? spokenNames([String(cut[1])])[0] : null;
    const first = `Seats ${change < 0 ? "fell" : "rose"} ${percent} between ${years[0]} and ${years[1]}${city ? `, and the biggest cut was ${city}` : ""}.`;
    return [first, "The data shows what changed, not why."];
  }

  if (head.startsWith("weather")) {
    const category = rowByLabel(/flight category/i)?.[1];
    if (typeof category !== "string" || !/^[A-Z]{3,4}$/.test(category)) return null;
    const wind = asNumber(rowByLabel(/^wind/i)?.[1]);
    const windClause = wind === null ? "" : wind < 1 ? ", with calm wind" : `, with wind around ${countWord(Math.round(wind))} knots`;
    return [`It's ${category} right now${windClause}.`];
  }

  if (head.startsWith("faa status")) {
    const types = [...new Set(rows.map((row) => String(row[0]).toLowerCase()))];
    if (types.length === 1 && types[0] === "none") {
      return ["The FAA isn't reporting any ground stop, delay or closure right now, though that doesn't rule out smaller delays."];
    }
    const known = types.filter((t) => ["ground stop", "ground delay program", "arrival departure delay", "closure"].includes(t)).slice(0, 3);
    if (known.length === 0) return null;
    return [`The FAA is reporting ${joinNames(known.map((t) => `a ${t}`))} right now.`];
  }

  if (head.startsWith("bts")) {
    const passengers = asNumber(rowByLabel(/enplaned passengers/i)?.[1]);
    return passengers === null ? null : [`In the latest year of BTS data, about ${figure(passengers)} passengers boarded there.`];
  }

  if (head.startsWith("faa infrastructure")) {
    const runways = asNumber(rowByLabel(/^runways$/i)?.[1]);
    const longest = asNumber(rowByLabel(/longest runway/i)?.[1]);
    if (runways === null) return null;
    const count = `${countWord(runways)} ${runways === 1 ? "runway" : "runways"}`;
    return [longest === null ? `It has ${count}.` : `It has ${count}, and the longest is about ${figure(longest)} feet.`];
  }

  if (head.startsWith("census")) {
    const population = asNumber(rowByLabel(/population/i)?.[1]);
    return population === null ? null : [`The metro area has about ${figure(population)} people.`];
  }

  if (head.startsWith("live activity")) {
    const total = asNumber(rowByLabel(/total/i)?.[1]);
    const airborne = asNumber(rowByLabel(/airborne/i)?.[1]);
    if (total === null) return null;
    const detail = airborne === null ? "" : `, ${countWord(airborne)} of them airborne`;
    return [`About ${countWord(total)} aircraft are in the area right now${detail}.`];
  }

  return null;
}

/**
 * Template v2: one or two short, natural sentences summarising a structured table, or null when
 * the table has no usable rows or is a shape this does not know how to say.
 */
export function toSpokenSummary(
  data: StructuredResult | null | undefined,
  uncertainty?: string | null,
): string | null {
  if (!data || data.rows.length === 0) return null;
  const summary =
    data.kind === "ranking"
      ? rankingSummary(data, uncertainty)
      : data.kind === "comparison"
        ? comparisonSummary(data, uncertainty)
        : data.kind === "breakdown"
          ? breakdownSummary(data)
          : metricSummary(data);
  return summary && summary.length > 0 ? speakSentences(summary) : null;
}

// --------------------------------------------------------------------------- //
// Replies with no table
// --------------------------------------------------------------------------- //

const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/g;

/** Plain text for the ear: markdown, links, emoji and list markers gone, one sentence per line. */
function proseForSpeech(reply: string): string {
  return stripMarkdown(reply)
    .replace(URL_PATTERN, "")
    .replace(EMOJI, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // A list item or heading has no full stop of its own; give it one so items don't run together.
    .map((line) => (/[.!?:]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

/**
 * The written reply, for answers with no structured result: every whole sentence while it
 * stays short, otherwise as many whole sentences as fit MAX_PROSE_CHARS plus a pointer to the
 * screen. It never cuts inside a sentence; a single over-long first sentence is spoken whole.
 */
export function toSpokenProse(reply: string): string | null {
  const sentences = splitIntoSentences(proseForSpeech(reply))
    .map((sentence) => endWithPunctuation(normaliseForSpeech(sentence)))
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  if (sentences.length === 0) return null;

  const kept: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (kept.length > 0 && length + sentence.length + 1 > MAX_PROSE_CHARS) break;
    kept.push(sentence);
    length += sentence.length + 1;
  }
  if (kept.length < sentences.length) kept.push("The rest is on screen.");
  return kept.join(" ");
}

/** What to read aloud for an answer: the code-built summary, else the whole short reply. */
export function buildSpokenText(
  reply: string,
  structured: StructuredResult | null | undefined,
  uncertainty?: string | null,
): string | null {
  return toSpokenSummary(structured, uncertainty) ?? toSpokenProse(reply);
}
