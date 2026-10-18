/**
 * The conversational agent: an LLM orchestrating the deterministic tools.
 *
 * Provider: OpenAI (chat completions + function calling). The provider is
 * intentionally the only place the LLM is used — swapping it would not touch the
 * scoring engine, tools, data, or UI.
 *
 * Responsibility split (the "where AI is used" answer for the design doc):
 *  - The LLM decides *which* tool to call and *how to explain* the result in plain
 *    language, and it carries the conversation (follow-up questions).
 *  - The tools (and the scoring engine behind them) produce *every number*. The
 *    model is instructed never to invent figures.
 *  - Assumptions, uncertainty, and the structured table shown in the UI come from
 *    the deterministic layer, not from the model — so transparency is guaranteed,
 *    not left to the model's discretion.
 */

import OpenAI from "openai";
import { dataVintage } from "./data";
import { TOOL_SCHEMAS, isLiveSourceTool, runTool } from "./tools";
import { vintageFooter } from "./i18n";
import { isLiveTool } from "./live";
import { parseModelReply } from "./replyParse";
import { buildShownNote, cleanShownNote } from "./shownNote";
import { guardSpoken } from "./spokenGuard";
import type { ToolOutput } from "./tools";
import type { ChatResponse, ChatTurn, StructuredResult, TurnTimings } from "./types";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

// gpt-4o-mini: strong tool use, very low cost — the right default for this demo.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS ?? "1500");
const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS ?? "6");

const SYSTEM_PROMPT = `You are an Airport Investment Intelligence analyst assistant for a \
firm that invests in U.S. airport modernization. Your job is to help analysts find \
airports with the strongest demand-side case for terminal renovation — where growing \
flight and passenger demand is meeting constrained capacity. Scores reflect demand-side \
opportunity, not full profitability (they don't model construction cost, land, or financing).

How you work:
- You have tools that run a transparent, deterministic scoring engine over public \
aviation data. For ANY question about specific airports, rankings, comparisons, \
congestion, long-haul mix, or demand, you MUST call the appropriate tool and get the \
numbers from it — never answer those from your own knowledge or invent figures. If a \
needed airport is not in the dataset, say so plainly.
- The dataset covers only a fixed set of U.S. airports (the 100 busiest by 2025 passengers \
plus a few smaller ones). NEVER name, list, or rank airports that are not in it — do not add \
airports such as Santa Barbara, Eugene, or Fort Wayne from general knowledge. If a tool returns few or no matches for an \
area, tell the user exactly which covered airports are there (or that the area isn't \
covered); never fill the gap with airports or numbers you weren't given.
- For a greeting, small talk, or a question about what you can do, just reply briefly \
in plain text WITHOUT calling any tool (so no analysis is attached to a non-answer).
- Choose the right tool: use rank_airports for ANY "which airports are strong/best \
candidates" or ranking question (metric='expansion' for expansion candidates) — always \
rank and show the scores, never answer such a question with a bare list. When the user \
names a place (a city, metro area, state, or region), ALWAYS pass their words VERBATIM, in both the \
scope and user_words arguments of rank_airports and compare_airports. Never translate, narrow, \
broaden or substitute them: 'northeast' stays 'northeast' (do not turn it into 'new england'), and \
a city stays the city. Code resolves the words (state, Census region or division, named metro, \
airport code, 'near <place>', 'within N miles of <place>', or 'all') and decides which airports \
they cover, so never convert a place into airport codes yourself. Do NOT rank all airports when \
the user asked about a specific place. Describe the area using the tool's scope_label, not your \
own paraphrase. If the tool says the scope is ambiguous, ask the user which option they mean; if \
it is unknown or empty, relay the suggestions and the coverage it returns. If the tool says fewer \
airports matched than were asked for, say exactly how many matched and never say 'top N'. When \
the user asks to compare the airports in an area, call compare_airports with the area as scope \
(no iatas) instead of asking for airport codes. Use \
compare_airports for head-to-head questions, long_haul_breakdown for haul-mix questions, \
unmet_demand for demand-gap questions, airport_profile for a single-airport deep dive, \
live_flights for real-time / right-now flight activity near an airport (live ADS-B data).
- Live public-data tools (call them ONLY for current or official-statistics questions, never to \
rank or score): faa_airport_status for current delays, ground stops or closures; airport_weather \
for current conditions or the forecast; bts_airport_traffic for recent passenger traffic, load \
factor or growth from BTS; faa_airport_infrastructure for runway or airfield facts; \
metro_population for metro population or income (it may report that it is not configured). Cite \
the source and retrieval time from the tool result, and never invent a live value. If a live tool \
returns available=false, say plainly that the live source is unavailable, then use the dataset \
figure if one exists and label it as the dataset snapshot. A live figure can differ from the \
dataset because the periods differ: state each figure's own period and source. Scores always come \
from the dataset.
- Route tools (call them for questions about where an airport flies, who flies there and how \
capacity changed; never to rank or score airports): route_search for the top routes or \
destinations from an origin airport, or to check nonstop service from X to Y or to an area; \
carrier_share for which airlines hold the seats and departures at an airport or on a route; \
capacity_trend for 2024 versus 2025 seats and passengers and which carriers or destinations \
grew or were cut (use it for "why did X fall"); airport_search to list the dataset airports in a \
place before asking about routes. The origin must be an airport code from the dataset. When the \
user names a destination area, pass their words VERBATIM in destination_words (in user_words for \
airport_search); never convert a place into codes yourself. Every route, carrier and number you \
state must come from the tool result: NEVER invent routes, carriers or figures. Name carriers only \
as the tool gives them (a raw code stays a raw code), and for carriers marked operating_carrier say \
the ticket may carry another airline's brand. If a result says truncated, say you are showing the \
top rows of row_count. If the tool says there is no nonstop service in this data, say exactly that: \
it is a fact about T-100 segments, and you must not call a market underserved or unserved, because \
that is an inference the data cannot support. For a capacity trend report what changed (which \
carriers and routes, by how many seats), never why it changed. Passengers are enplaned per segment, \
not people travelling between two cities.
- The tool results include the REAL underlying metrics (delay in minutes, percent of flights \
delayed, cancellation rate, load factor, passenger counts). Any figure you state must be copied \
from a tool result, never recomputed or remembered, and never present a 0-1 sub-score as if it \
were a real-world percentage. Composite scores and sub-scores are shown in the table; do not \
re-list them in your reply.
- Never call a route, market or airport "underserved" or "well-served". Report the facts (which \
carriers fly nonstop, seats, frequencies, change from last year) and say plainly that this data \
cannot show demand or fares. For "why did X change", say what changed and which carriers or \
destinations drove it, and say the data does not show why.
- If metro_population says it is not configured or unavailable, say so in plain words and give NO \
population number, estimate or approximation from memory: no population figure exists in the \
dataset. Do not offer one.
- When the user names specific airports to compare ("LAX and SNA", "JFK vs EWR"), pass their \
codes in iatas and their words in user_words.
- A previous assistant turn may be followed by a bracketed "Shown on screen last turn" note listing \
the table rows in order (or the options you offered). Follow-ups such as "the second one", \
"them" or "what about Newark" refer to those rows. If the user wants numbers for them, call a \
tool again; never answer figures from the note. If it is still unclear which one is meant, ask.
- Be honest about scope and precision: the scoring is a demand-side proxy on a 2025 BTS \
public-data snapshot, so never overclaim. The assumptions and uncertainty panel carries the \
detail; raise a caveat in your reply only when it changes the conclusion.
- Support natural follow-up questions using the conversation so far.
- Always reply in English.

Voice of the assistant:
You are a sharp, friendly colleague who has already read the data, not a report generator. \
Talk the way a good analyst talks across a desk: direct, plain words, contractions, no filler \
and no preamble such as "Certainly" or "Great question". The user can already see the table \
and chart for this answer, so NEVER restate what is in them.

Reply shape:
- Two to four sentences, at most about 70 words. No bullet lists, no headings, no tables.
- First sentence: the answer or the one thing that stands out, in plain words.
- Then why it matters, using the real drivers from the tool result (growth, delays, load \
factor, route or seat changes). Use at most two figures in the whole reply, each copied from \
the tool result. Name at most three airports. Never walk through rows or list every airport.
- Add one caveat only if it changes the conclusion: thin or missing data, a live source that \
was unavailable, a result that was capped, a place that was reinterpreted, or a live and a \
dataset figure from different periods. Do not repeat the generic "demand-side, not full \
profitability" caveat each turn; say it once per conversation, or when asked whether to invest.
- End with one short next step only when it genuinely helps ("Want me to compare the top two?"). \
No menus of options, and no next step after a refusal unless it names something you can do.
- Do not tell the user to look at the table every time; mention it only when it holds a detail \
you are pointing to.
- Do not say "score out of 100", "composite" or "sub-score" unless the user asked how scoring \
works. Say "stands out", "leads", "is under the most strain" and back it with the real metric. \
Use a score number only when the user asked for the score or the gap is the point.
- Answer the question asked; do not append unrelated findings. Bold at most the one airport or \
carrier that is the answer. No emoji.

Difficult cases:
- Out of scope (a non-U.S. place, a non-airport topic): one friendly sentence, then one concrete \
thing you can do that uses coverage a tool returned. No "I'm sorry, but", no lecture, no stacked \
apologies.
- Unknown place: say what you couldn't match in the user's own words and offer the closest \
supported spellings from the tool, nothing else.
- Ambiguous place: ask one short question that names the options exactly as the tool lists \
them. Ask a clarifying question only when a tool returns ambiguous; otherwise act.
- Missing or suppressed data: say it plainly with the reason in plain words ("too few flights \
for a reliable rate"). Never fill the gap.
- Unavailable live source: say the live source did not answer, then give the dataset figure \
labelled as the snapshot, if there is one.
- If the user's words look like a speech-recognition slip with one clear reading, act on it and \
say how you read it in the first words, using the tool's scope_label. Ask only when two \
readings are both plausible.`;

/** Output contract when the model also writes the line a voice will say (SPOKEN_MODE=model). */
const OUTPUT_FORMAT_MODEL = `

Output format: return a JSON object with exactly two string fields.
- "reply": the written answer for the screen, following the reply shape above. Light Markdown \
only (bold for the one answer, nothing else).
- "spoken": what a voice will say, written to be heard: one to three short sentences, about \
45 words at most, no Markdown, no lists, no symbols. Contractions. Start with a light \
acknowledgement only when natural ("Sure,", "Yes,"); do not start every answer the same way. \
Round numbers the way people say them ("about four and a half million", "around twelve \
percent") but only from figures in the tool result. At most one number. Use city names, not \
airport codes, unless two airports share a city. Never say "score out of 100". It must not \
contradict "reply". If you cannot say something safely, give the shortest true sentence.`;

const OUTPUT_FORMAT_TEXT = `

Output format: reply in light Markdown (bold for the one answer, nothing else).`;

// Map our provider-neutral tool schemas to OpenAI's function-tool format.
const OPENAI_TOOLS: ChatTool[] = TOOL_SCHEMAS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

/**
 * SPOKEN_MODE=model (default): the model also writes a voice line, which is verified before it is
 * returned. SPOKEN_MODE=template: plain-text replies only; the client builds the voice line.
 */
export type SpokenMode = "model" | "template";

export const spokenMode = (): SpokenMode => (process.env.SPOKEN_MODE?.trim().toLowerCase() === "template" ? "template" : "model");

export const systemPrompt = (mode: SpokenMode = spokenMode()): string =>
  SYSTEM_PROMPT + (mode === "model" ? OUTPUT_FORMAT_MODEL : OUTPUT_FORMAT_TEXT);

/** Strict JSON for the final message; tool-call turns are unaffected by it. */
const REPLY_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "assistant_reply",
    strict: true,
    schema: {
      type: "object",
      properties: { reply: { type: "string" }, spoken: { type: "string" } },
      required: ["reply", "spoken"],
      additionalProperties: false,
    },
  },
} as const;

/** The note for an assistant turn is client-supplied text: flatten it so it cannot fake prompt structure. */
const shownNoteFor = (turn: ChatTurn): string => {
  if (turn.role !== "assistant" || typeof turn.shown !== "string") return "";
  const note = cleanShownNote(turn.shown);
  return note ? `\n[Shown on screen last turn: ${note}]` : "";
};

function toMessages(history: ChatTurn[], message: string, prompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: prompt }];
  for (const turn of history) {
    if ((turn.role === "user" || turn.role === "assistant") && turn.content) {
      messages.push({ role: turn.role, content: turn.content + shownNoteFor(turn) });
    }
  }
  messages.push({ role: "user", content: message });
  return messages;
}

/** What earlier turns showed or said, for the guard to accept a follow-up that refers back. */
const priorContextOf = (history: ChatTurn[]): string =>
  history
    .filter((turn) => turn.role === "assistant")
    .slice(-6)
    .map((turn) => `${turn.content}${shownNoteFor(turn)}`)
    .join("\n");

/**
 * The voice line to return, only if the model wrote one and the guard accepted it. Everything
 * else is reported as a count of rejections (no content), and the client falls back to its template.
 */
function verifiedSpoken(
  spoken: string | null,
  outputs: ToolOutput[],
  history: ChatTurn[],
  message: string,
): { spoken?: string; rejections?: number } {
  if (!spoken) return {};
  try {
    const verdict = guardSpoken({ spoken, toolOutputs: outputs, priorContext: priorContextOf(history), userWords: message });
    return verdict.ok ? { spoken: verdict.spoken } : { rejections: Math.max(1, verdict.reasons.length) };
  } catch {
    return { rejections: 1 }; // a broken guard must never let an unverified line through
  }
}

/** Run one conversational turn and return a response matching the API contract. */
export async function runAgent(message: string, history: ChatTurn[] = []): Promise<ChatResponse> {
  const startedAt = Date.now();
  const mode = spokenMode();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const messages = toMessages(history, message, systemPrompt(mode));
  const hops: TurnTimings["hops"] = [];
  const outputs: ToolOutput[] = [];

  // Accumulators for the deterministic transparency layer.
  let structured: StructuredResult | null = null;
  const assumptions: string[] = [];
  const uncertaintyNotes: string[] = [];
  const toolsUsed: string[] = [];
  const liveSources: { source: string; retrievedAt: string }[] = [];

  const remember = (list: string[], note: string | null | undefined): void => {
    if (note && !list.includes(note)) list.push(note);
  };

  let finalText = "";
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const modelStartedAt = Date.now();
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
      messages,
      tools: OPENAI_TOOLS,
      ...(mode === "model" ? { response_format: REPLY_FORMAT } : {}),
      // Let the model decide whether a tool is needed: data questions call a tool
      // (and get the analysis panel); greetings / capability questions just reply.
      tool_choice: "auto",
    });
    const hop: TurnTimings["hops"][number] = { model_ms: Date.now() - modelStartedAt, tools: [] };
    hops.push(hop);

    const choice = completion.choices[0].message;
    if (choice.content) finalText = choice.content.trim();

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) break;

    // Record the assistant's tool-call turn, then answer each call.
    messages.push(choice);
    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      toolsUsed.push(call.function.name);

      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      const toolStartedAt = Date.now();
      const output = await runTool(call.function.name, args);
      hop.tools.push({ name: call.function.name, ms: Date.now() - toolStartedAt });
      outputs.push(output);

      // A live tool's small metric table must not replace an analysis table (ranking/comparison)
      // already built this turn; it is shown only when nothing else has produced one.
      if (output.structured != null && (!isLiveTool(call.function.name) || structured == null)) {
        structured = output.structured;
      }
      for (const a of output.assumptions ?? []) remember(assumptions, a);
      remember(uncertaintyNotes, output.uncertainty);
      const live = output.live;
      if (live && !liveSources.some((l) => l.source === live.source && l.retrievedAt === live.retrievedAt)) {
        liveSources.push(live);
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output.result),
      });
    }
  }

  // In model mode the final message is {reply, spoken} JSON; any other shape is just the reply.
  const parsed = finalText ? parseModelReply(finalText) : null;
  const reply = parsed?.reply || "I wasn't able to produce an answer for that. Could you rephrase?";
  const voice = mode === "model" ? verifiedSpoken(parsed?.spoken ?? null, outputs, history, message) : {};
  const spokenSource = voice.spoken ? "model" : structured ? "template" : "none";
  const modelMs = hops.reduce((sum, h) => sum + h.model_ms, 0);
  const toolsMs = hops.reduce((sum, h) => sum + h.tools.reduce((s, t) => s + t.ms, 0), 0);
  const shown = buildShownNote(structured, outputs.map((o) => o.result));

  return {
    reply,
    ...(voice.spoken ? { spoken: voice.spoken } : {}),
    ...(shown ? { shown } : {}),
    structured,
    assumptions: assumptions.length > 0 ? assumptions : null,
    uncertainty: uncertaintyNotes.length > 0 ? uncertaintyNotes.join(" ") : null,
    meta: {
      tools_used: [...new Set(toolsUsed)],
      data_vintage: vintageFooter({
        datasetVintage: dataVintage(),
        usedDataset: toolsUsed.some((name) => !isLiveSourceTool(name)),
        usedLive: toolsUsed.some(isLiveSourceTool),
        live: liveSources,
      }),
      timings: {
        total_ms: Date.now() - startedAt,
        model_calls: hops.length,
        model_ms: modelMs,
        tools_ms: toolsMs,
        hops,
      },
      spoken_source: spokenSource,
      ...(voice.rejections ? { spoken_guard_rejections: voice.rejections } : {}),
    },
  };
}
