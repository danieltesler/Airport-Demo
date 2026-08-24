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
import { detectLang } from "./i18n";
import { TOOL_SCHEMAS, runTool } from "./tools";
import type { ChatResponse, ChatTurn, StructuredResult } from "./types";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

// gpt-4o-mini: strong tool use, very low cost — the right default for this demo.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS ?? "1500");
const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS ?? "6");

const SYSTEM_PROMPT = `You are an Airport Investment Intelligence analyst assistant for a \
firm that invests in U.S. airport modernization. Your job is to help analysts find \
airports where terminal renovation would be most profitable, driven by growing flight \
and passenger demand meeting constrained capacity.

How you work:
- You have tools that run a transparent, deterministic scoring engine over public \
aviation data. For ANY question about specific airports, rankings, comparisons, \
congestion, long-haul mix, or demand, you MUST call the appropriate tool and get the \
numbers from it — never answer those from your own knowledge or invent figures. If a \
needed airport is not in the dataset, say so plainly.
- For a greeting, small talk, or a question about what you can do, just reply briefly \
in plain text WITHOUT calling any tool (so no analysis is attached to a non-answer).
- Choose the right tool: use rank_airports for ANY "which airports are strong/best \
candidates" or ranking question (metric='expansion' for expansion candidates) — always \
rank and show the scores, never answer such a question with a bare list. Use \
compare_airports for head-to-head questions, long_haul_breakdown for haul-mix questions, \
unmet_demand for demand-gap questions, airport_profile for a single-airport deep dive.
- Explain your reasoning clearly and concisely: state the headline answer first, then \
the key drivers behind the score in plain English. Composite scores are on a 0-100 \
scale; the tool results also include the REAL underlying metrics (delay in minutes, \
percent of flights delayed, cancellation rate, load factor, passenger counts). Cite \
those real figures when explaining, and never present a 0-1 sub-score as if it were a \
real-world percentage.
- Be explicit about assumptions, uncertainty, and scope. The scoring is a demand-side \
proxy on a curated public-data snapshot — never overclaim precision.
- Support natural follow-up questions using the conversation so far.
- Reply in the SAME language the analyst writes in: if they ask in Hebrew, answer \
entirely in Hebrew (prose, headings, and explanations); if in English, answer in \
English. Keep airport codes (e.g. BOS, SFO) as-is.

Formatting: reply in concise Markdown. Use short paragraphs and, where helpful, a \
compact list. Do not paste large tables in your text — the UI renders the structured \
table separately; refer to it (e.g. "see the ranking below").`;

// Map our provider-neutral tool schemas to OpenAI's function-tool format.
const OPENAI_TOOLS: ChatTool[] = TOOL_SCHEMAS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

function toMessages(history: ChatTurn[], message: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const turn of history) {
    if ((turn.role === "user" || turn.role === "assistant") && turn.content) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: "user", content: message });
  return messages;
}

/** Run one conversational turn and return a response matching the API contract. */
export async function runAgent(message: string, history: ChatTurn[] = []): Promise<ChatResponse> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const messages = toMessages(history, message);
  // The deterministic assumptions/uncertainty are localized to the user's language.
  const lang = detectLang(message);

  // Accumulators for the deterministic transparency layer.
  let structured: StructuredResult | null = null;
  const assumptions: string[] = [];
  const uncertaintyNotes: string[] = [];
  const toolsUsed: string[] = [];

  const remember = (list: string[], note: string | null | undefined): void => {
    if (note && !list.includes(note)) list.push(note);
  };

  let finalText = "";
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: OPENAI_TOOLS,
      // Let the model decide whether a tool is needed: data questions call a tool
      // (and get the analysis panel); greetings / capability questions just reply.
      tool_choice: "auto",
    });

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
      const output = runTool(call.function.name, args, lang);

      if (output.structured != null) structured = output.structured;
      for (const a of output.assumptions ?? []) remember(assumptions, a);
      remember(uncertaintyNotes, output.uncertainty);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output.result),
      });
    }
  }

  return {
    reply: finalText || "I wasn't able to produce an answer for that. Could you rephrase?",
    structured,
    assumptions: assumptions.length > 0 ? assumptions : null,
    uncertainty: uncertaintyNotes.length > 0 ? uncertaintyNotes.join(" ") : null,
    meta: {
      tools_used: [...new Set(toolsUsed)],
      data_vintage: dataVintage(),
      lang,
    },
  };
}
