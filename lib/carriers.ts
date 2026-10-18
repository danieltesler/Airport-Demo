/**
 * Carrier names for the BTS carrier codes used in the route data.
 *
 * The route table carries only BTS UNIQUE_CARRIER codes. data/carriers.json maps the codes
 * that matter (99% of 2025 seats) to names, taken from the BTS carrier lookup table, and its
 * meta block states the source. A code that is not in the table is shown as the raw code:
 * a name is never guessed.
 */

import table from "@/data/carriers.json";

interface CarrierRecord {
  name: string;
  bts_description: string;
  operating_carrier?: boolean;
}

const CARRIERS = table.carriers as Record<string, CarrierRecord>;

export interface CarrierInfo {
  code: string;
  /** Display name from the BTS lookup; null when the code is not in the table. */
  name: string | null;
  /** A regional airline that flies under another airline's brand, so the ticket may show a different name. */
  operatingCarrier: boolean;
  /** Text for tables and replies, e.g. "Southwest Airlines (WN)" or the raw code when unknown. */
  label: string;
}

export function describeCarrier(code: string): CarrierInfo {
  const record = CARRIERS[code];
  if (!record) return { code, name: null, operatingCarrier: false, label: code };
  const operatingCarrier = record.operating_carrier === true;
  const label = operatingCarrier ? `${record.name} (${code}, operating carrier)` : `${record.name} (${code})`;
  return { code, name: record.name, operatingCarrier, label };
}

/** Where the names come from, for provenance text and tests. */
export function carrierTableSource(): { source: string; url: string; retrieved: string; codes: number } {
  const { source, url, retrieved } = table.meta;
  return { source, url, retrieved, codes: Object.keys(CARRIERS).length };
}

export type CarrierLookup =
  | { ok: true; code: string; label: string }
  | { ok: false; reason: "unknown" | "ambiguous"; options: string[] };

const lower = (text: string): string => text.trim().toLowerCase();

/**
 * Find a carrier from what a person says: a BTS code ("WN"), a name ("Southwest", "Southwest
 * Airlines") or a distinctive word ("Spirit"). Only carriers in data/carriers.json can be named;
 * several matches are ambiguous (the caller asks), none is unknown. Never guesses.
 */
export function findCarrier(input: string): CarrierLookup {
  const text = lower(input).replace(/\s+airlines?$|\s+air lines$|\s+airways$/, "");
  if (!text) return { ok: false, reason: "unknown", options: [] };
  const entries = Object.entries(CARRIERS);

  const byCode = entries.find(([code]) => code.toLowerCase() === lower(input));
  if (byCode) return { ok: true, code: byCode[0], label: describeCarrier(byCode[0]).label };

  const exact = entries.filter(([, r]) => lower(r.name) === lower(input) || lower(r.name).replace(/\s+(airlines?|air lines|airways)$/, "") === text);
  const hasWord = (name: string): boolean => ` ${lower(name)} `.includes(` ${text} `);
  const matches = exact.length > 0 ? exact : entries.filter(([, r]) => hasWord(r.name));
  if (matches.length === 1) return { ok: true, code: matches[0][0], label: describeCarrier(matches[0][0]).label };
  return { ok: false, reason: matches.length === 0 ? "unknown" : "ambiguous", options: matches.map(([code]) => describeCarrier(code).label) };
}

/** Carrier names people use on their own ("Southwest", "Spirit"). Anything else must be named in full. */
const BARE_NAMES = new Set([
  "southwest", "spirit", "delta", "american", "united", "jetblue", "frontier", "allegiant", "hawaiian",
  "breeze", "avelo", "alaska", "sun country",
]);
const SUFFIX = /\s+(airlines?|air lines|airways)$/;
/** Bare names that are also ordinary words: only read as the airline in these company. */
const NOT_BEFORE: Record<string, RegExp> = {
  united: /^ states\b/,
  alaska: /^(?! air)/, // "Alaska" alone is the state; "Alaska Air/Airlines" is the airline
  american: /^ (?:airports?|cities|city|people|travell?ers|states)\b/,
};

/**
 * The airlines a message names (by name, never by two-letter code), longest name first so "Air Canada
 * Rouge" is not also read as "Air Canada". Used so a carrier the user named can never be dropped by a model
 * that forgot the argument.
 */
export function carriersNamedIn(message: string | undefined): { code: string; label: string }[] {
  const text = ` ${lower(message ?? "").replace(/['’]s\b/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  const phrases: { phrase: string; code: string; bare: boolean }[] = [];
  for (const [code, record] of Object.entries(CARRIERS)) {
    const full = lower(record.name);
    phrases.push({ phrase: full, code, bare: false });
    const short = full.replace(SUFFIX, "");
    if (short !== full && BARE_NAMES.has(short)) phrases.push({ phrase: short, code, bare: true });
    if (short === full && BARE_NAMES.has(full)) phrases.push({ phrase: full, code, bare: true });
  }
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);

  const taken: [number, number][] = [];
  const found: { code: string; label: string }[] = [];
  for (const { phrase, code, bare } of phrases) {
    const needle = ` ${phrase} `;
    const at = text.indexOf(needle);
    if (at < 0 || found.some((f) => f.code === code)) continue;
    const start = at + 1;
    const end = at + needle.length - 1;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    const after = text.slice(end);
    if (bare && NOT_BEFORE[phrase]?.test(after)) continue;
    taken.push([start, end]);
    found.push({ code, label: describeCarrier(code).label });
  }
  return found;
}
