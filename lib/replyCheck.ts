/**
 * Checks on the written reply, run by code after the model answers. A model that skips the right
 * tool, remembers a figure, calls a decline "driven by" a cause, labels a trailing window as a year,
 * or refuses a question the dataset can answer cannot be fixed with prompt wording alone, so the
 * answer is checked against this turn's tool results and, if it fails, the model gets one corrective
 * retry (see lib/agent.ts). What still fails afterwards is replaced by a reply built by code from the
 * tool results, never patched sentence by sentence.
 *
 * The figure check starts from the spoken-line guard's number grounding (lib/spokenGuard.ts) and then
 * accepts sensible roundings of grounded values (5.3 million for 5,290,031; 906000 for 906,213).
 */

import * as data from "./data";
import { asksForCalendarYear } from "./calendarYear";
import { guardSpoken } from "./spokenGuard";

export interface ReplyContext {
  /** The user's message; figures they said themselves may be repeated. */
  message: string;
  /** Every tool output of this turn. */
  outputs: readonly unknown[];
  /** Earlier turns, so a follow-up may refer back to a figure already shown. */
  priorContext: string;
  /** Documented constants of the dataset and method (see data.documentedConstants). */
  staticFacts: readonly number[];
  toolsUsed: readonly string[];
}

export type ReplyIssue =
  | { kind: "figures"; figures: string[] }
  | { kind: "causal"; phrases: string[] }
  | { kind: "period" }
  | { kind: "refusal" };

/** The reply as plain text for number extraction: no markdown, and "7034708 in 2024" is not read as a ratio "N in M". */
const plain = (reply: string): string =>
  reply
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\d)\s+in\s+((?:19|20)\d\d)\b/g, "$1 during $2");

// --------------------------------------------------------------------------- //
// Figures
// --------------------------------------------------------------------------- //

/** Every number in the tool outputs (and table cells), plus 100x for ratios, as absolute values. */
function groundedNumbers(outputs: readonly unknown[], extra: readonly number[]): number[] {
  const found: number[] = [...extra];
  const add = (n: number): void => {
    if (!Number.isFinite(n)) return;
    const abs = Math.abs(n);
    found.push(abs);
    if (abs <= 1) found.push(abs * 100);
  };
  const walk = (value: unknown): void => {
    if (typeof value === "number") add(value);
    else if (typeof value === "string") {
      for (const m of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) add(Number(m.replace(/,/g, "")));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      // A tool output is { result, structured, ... }; its notes and caveat text are not facts about the answer.
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key !== "assumptions" && key !== "uncertainty") walk(inner);
      }
    }
  };
  outputs.forEach(walk);
  return found;
}

const SCALES: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9 };

/** A written figure as a value and the size of the step its last digit stands for. */
export function parseFigure(text: string): { value: number; place: number; percent: boolean } | null {
  const match = text.trim().match(/^(-?\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|percent|%|k|m)?/i);
  if (!match) return null;
  const digits = match[1].replace(/,/g, "");
  const unit = (match[2] ?? "").toLowerCase();
  const scale = SCALES[unit] ?? 1;
  const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
  const value = Math.abs(Number(digits)) * scale;
  let place: number;
  if (scale > 1 || decimals > 0) place = scale * 10 ** -decimals;
  else {
    const zeros = digits.match(/0+$/)?.[0].length ?? 0;
    place = value >= 1000 ? 10 ** zeros : 1;
  }
  return Number.isFinite(value) ? { value, place, percent: unit === "%" || unit === "percent" } : null;
}

/** Is this figure a rounding (up, down or to the nearest step) of something the tool results say? */
function roundingOfGrounded(figure: string, grounded: readonly number[]): boolean {
  const parsed = parseFigure(figure);
  if (!parsed) return false;
  // "over 30%" for 31.7: a bare whole number is read to within about 6%, a figure with decimals or a scale to its own step.
  const wholeNumber = parsed.place === 1 && parsed.value < 1000;
  const tolerance = Math.max(parsed.place, parsed.value * (wholeNumber ? 0.06 : 0.01));
  return grounded.some((fact) => Math.abs(fact - parsed.value) <= tolerance);
}

/** Written figures with digits that match nothing in the tool results (small bare counts are ignored). */
export function unsupportedFigures(reply: string, context: ReplyContext): string[] {
  let verdict: ReturnType<typeof guardSpoken>;
  try {
    verdict = guardSpoken({
      spoken: plain(reply),
      toolOutputs: context.outputs,
      priorContext: context.priorContext,
      userWords: context.message,
      staticFacts: [...context.staticFacts],
    });
  } catch {
    return []; // a broken checker never blocks an answer
  }
  const grounded = groundedNumbers([...context.outputs], [...context.staticFacts]);
  // Figures from earlier turns and the user's own message may be repeated.
  for (const text of [context.priorContext, context.message]) {
    for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) grounded.push(Number(m.replace(/,/g, "")));
  }
  const figures: string[] = [];
  for (const reason of verdict.reasons) {
    const found = reason.match(/^number: "(.+)" is not in the tool results/);
    if (!found || !/\d/.test(found[1])) continue;
    const value = Number(found[1].replace(/[^0-9.]/g, ""));
    const substantial = /[%.]/.test(found[1]) || (Number.isFinite(value) && value >= 10);
    if (!substantial || roundingOfGrounded(found[1], grounded)) continue;
    if (!figures.includes(found[1])) figures.push(found[1]);
  }
  return figures;
}

// --------------------------------------------------------------------------- //
// Causal wording, period labels, refusals
// --------------------------------------------------------------------------- //

const CAUSAL =
  /\b(driven by|driving|due to|because of|caused by|as a result of|resulted? (?:from|in)|owing to|attributed to|stems? from|stemming from|led to|leading to|contributed to|contributing to|the reason (?:is|was|for)|reflects?|reflecting|likely (?:due|because|reflects)|a result of|behind the (?:decline|drop|fall|cut))\b/gi;

const WHY_QUESTION = /\bwhy\b|\breason\b|\bcause\b|\bcaused\b|\bexplain\b|\bhow come\b/i;

/** Causal wording after a capacity question or a "why": the data shows what changed, not why. */
export function causalPhrases(reply: string, context: Pick<ReplyContext, "message" | "toolsUsed">): string[] {
  if (!WHY_QUESTION.test(context.message) && !context.toolsUsed.includes("capacity_trend")) return [];
  return [...new Set((reply.match(CAUSAL) ?? []).map((phrase) => phrase.toLowerCase()))];
}

const DATASET_TOOLS = new Set(["airport_profile", "rank_airports", "compare_airports", "long_haul_breakdown", "unmet_demand"]);
const LIVE_TOOLS = new Set(["faa_airport_status", "airport_weather", "bts_airport_traffic", "faa_airport_infrastructure", "live_flights"]);

const CALENDAR_LABEL =
  /\b(?:in|during|for|of|from|since)\s+(?:2024|2025)\b|\b(?:2024|2025)\b.{0,12}\b(?:vs\.?|versus|compared)\b|\blast year\b|\bcalendar\b/i;

/** Live trailing-12-month figures used, with no dataset tool, in a reply that labels them as a calendar year. */
export function mislabelsTrailingWindow(reply: string, context: Pick<ReplyContext, "message" | "toolsUsed">): boolean {
  if (!context.toolsUsed.includes("bts_airport_traffic")) return false;
  if (context.toolsUsed.some((name) => DATASET_TOOLS.has(name))) return false;
  return CALENDAR_LABEL.test(reply) || asksForCalendarYear(context.message);
}

const DECLINE =
  /(not (?:currently )?(?:reported|available)|isn't available|is not available|unavailable|don't have (?:that|the|a|any)|do not have (?:that|the|a|any)|can't (?:find|provide|give|share|see)|cannot (?:find|provide|give)|no data|isn't reported)/i;
const AIRPORT_FIGURE =
  /(delay|cancel|growth|growing|grow\b|passengers?|load factor|international|bigger|larger|smaller|busier|runways?|departures)/i;
const LIVE_QUESTION = /\b(right now|currently|today|tonight|live|at the moment)\b/i;

const NAMES = (): string[] =>
  data.allAirports().flatMap((a) => [a.iata.toLowerCase(), ...a.city.toLowerCase().split(/[-/,]/).map((part) => part.trim())]);
let airportNames: string[] | null = null;

/** The model declined a question about a named airport's figures without using any dataset tool. */
export function refusedAnswerableQuestion(reply: string, context: Pick<ReplyContext, "message" | "toolsUsed">): boolean {
  if (!DECLINE.test(reply) || !AIRPORT_FIGURE.test(context.message)) return false;
  if (context.toolsUsed.some((name) => DATASET_TOOLS.has(name) || LIVE_TOOLS.has(name))) return false;
  if (LIVE_QUESTION.test(context.message)) return false; // "right now" questions legitimately depend on a live source
  airportNames ??= NAMES();
  const padded = ` ${context.message.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return airportNames.some((name) => name.length >= 3 && padded.includes(` ${name} `));
}

export function findReplyIssues(reply: string, context: ReplyContext): ReplyIssue[] {
  const issues: ReplyIssue[] = [];
  const figures = unsupportedFigures(reply, context);
  if (figures.length > 0) issues.push({ kind: "figures", figures });
  const phrases = causalPhrases(reply, context);
  if (phrases.length > 0) issues.push({ kind: "causal", phrases });
  if (mislabelsTrailingWindow(reply, context)) issues.push({ kind: "period" });
  if (refusedAnswerableQuestion(reply, context)) issues.push({ kind: "refusal" });
  return issues;
}

/** The instruction for the one corrective retry. */
export function correctionFor(issues: ReplyIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.kind === "figures") {
      return (
        `Your answer includes figures that are not in the tool results: ${issue.figures.map((f) => `"${f}"`).join(", ")}. ` +
        "Use only figures from tool results. If you need a figure, call the right tool first (airport_profile for one airport's " +
        "passengers, international passengers, delays, cancellations, load factor, growth or runways) and quote it exactly; otherwise leave the figure out."
      );
    }
    if (issue.kind === "causal") {
      return (
        `Remove the causal wording (${issue.phrases.map((p) => `"${p}"`).join(", ")}). Say what changed and which carriers or ` +
        "destinations moved, and say plainly that the data does not show why."
      );
    }
    if (issue.kind === "period") {
      return (
        "Those live BTS figures are a trailing 12 months (see period_label), not a calendar year. Do not call them 2025, 2024 or last year. " +
        "For calendar-year figures call airport_profile and quote it."
      );
    }
    return "The bundled dataset does answer this question. Call airport_profile for the airport the user named and answer from its figures instead of saying it is unavailable.";
  });
  return `${lines.join(" ")} Then answer again in the same JSON format.`;
}

// --------------------------------------------------------------------------- //
// What replaces a reply that still fails
// --------------------------------------------------------------------------- //

/** Population, residents and demographics are not in the data and no tool returns them. */
const POPULATION_QUESTION = /\b(population|populations|populous|residents|inhabitants|demographics?|how many people (?:live|reside))\b/i;

export const NO_POPULATION_REPLY =
  "Population isn't part of this demo, so I can't give a figure. The data covers passengers, flights, routes and airlines: I can look up any of those for an airport or an area.";

/** True when the user asked about population and this turn used no tool: whatever figure the reply holds came from memory. */
export function inventsPopulation(context: Pick<ReplyContext, "message" | "toolsUsed">): boolean {
  return POPULATION_QUESTION.test(context.message) && context.toolsUsed.length === 0;
}

export const SAFE_REPLY =
  "I couldn't confirm the figures in my answer against the data, so I'm leaving them out. The table shows the verified numbers, and I can look up a specific figure if you tell me which one.";

/**
 * A reply written by code from the tool results: the airport facts sentence(s) and the capacity headline, which the
 * tools word and round themselves. Undefined when the results hold nothing to say (the caller then uses SAFE_REPLY).
 */
export function factualReply(outputs: readonly unknown[], hasTable: boolean): string | undefined {
  const sentences: string[] = [];
  for (const output of outputs) {
    const result = (output && typeof output === "object" && "result" in output ? (output as { result: unknown }).result : output) as
      | Record<string, unknown>
      | undefined;
    for (const key of ["facts_summary", "headline_facts"]) {
      const value = result?.[key];
      if (typeof value === "string" && !sentences.includes(value)) sentences.push(value);
    }
  }
  if (sentences.length === 0) return undefined;
  return `${sentences.join(" ")}${hasTable ? " The table has the full detail." : ""}`;
}

/** Remove only the sentences that contain a causal phrase (used when no factual reply exists). */
export function withoutCausalSentences(reply: string, phrases: string[]): string {
  const sentences = reply.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => !phrases.some((p) => s.toLowerCase().includes(p))).join(" ").trim();
}
