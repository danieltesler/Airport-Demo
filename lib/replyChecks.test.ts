/**
 * The written reply is checked by code against this turn's tool results (real guard, mocked model):
 * invented figures, causal wording after a "why", and refusing a question the dataset answers each
 * get ONE corrective retry; what still fails is removed rather than shown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async (_args?: unknown) => ({ choices: [{ message: queue.shift() }] })) };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { runAgent, systemPrompt } from "./agent";
import { SAFE_REPLY, causalPhrases, factualReply, parseFigure, refusedAnswerableQuestion, withoutCausalSentences } from "./replyCheck";

const toolCall = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const answer = (reply: string) => ({ role: "assistant", content: JSON.stringify({ reply, spoken: "Here is what I found." }) });

type Request = { messages: { role: string; content: string; tool_call_id?: string }[]; tool_choice?: string };
const request = (index: number): Request => createMock.mock.calls[index][0] as Request;
const lastUserMessage = (index: number): string => [...request(index).messages].reverse().find((m) => m.role === "user")!.content;

beforeEach(() => {
  scripted.length = 0;
  createMock.mockClear();
});

describe("invented figures (q26 JFK international passengers, q27 Atlanta growth)", () => {
  it("retries with the unsupported figures listed, the model then calls airport_profile and quotes the data", async () => {
    // The corrected answer quotes the data, built from it so the test follows the dataset.
    const { getAirport } = await import("./data");
    const jfk = getAirport("JFK")!;
    const international = Math.round(jfk.annual_passengers * jfk.international_passenger_share!);
    scripted.push(
      answer("JFK handled about 31 million passengers and roughly 12.5 million were international."),
      toolCall("airport_profile", { iata: "JFK" }),
      answer(`JFK handled ${jfk.annual_passengers.toLocaleString("en-US")} passengers in 2025, and ${international.toLocaleString("en-US")} were international.`),
    );
    const res = await runAgent("How many passengers did JFK handle in 2025, and how many were international?");

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(lastUserMessage(1)).toMatch(/figures that are not in the tool results: .*"12\.5 million"/);
    expect(lastUserMessage(1)).toMatch(/airport_profile/);
    expect(res.meta?.tools_used).toContain("airport_profile");
    expect(res.reply).toContain(international.toLocaleString("en-US"));
    expect(res.reply).not.toContain("12.5");
  });

  it("replaces a reply that still fails after the retry with one built by code from the tool results", async () => {
    const { getAirport } = await import("./data");
    const atl = getAirport("ATL")!;
    scripted.push(
      toolCall("airport_profile", { iata: "ATL" }),
      answer("Atlanta handled about 61.9 million passengers. This represents a significant portion of the U.S."),
      answer("Atlanta handled about 61.9 million passengers. This represents a significant portion of the U.S."),
    );
    const res = await runAgent("How many passengers did Atlanta handle?");
    expect(createMock).toHaveBeenCalledTimes(3); // one retry only
    expect(res.reply).not.toContain("61.9");
    expect(res.reply).not.toContain("significant portion"); // no orphaned fragments
    expect(res.reply).toContain(atl.annual_passengers.toLocaleString("en-US")); // facts_summary, worded by the tool
    expect(res.spoken).toBeUndefined();
  });

  it("falls back to the safe line when there is nothing to build a reply from", async () => {
    scripted.push(answer("Atlanta handled 52.3 million passengers."), answer("Atlanta handled 52.3 million passengers."));
    const res = await runAgent("How many passengers did Atlanta handle?");
    expect(res.reply).toBe(SAFE_REPLY);
  });

  it("accepts rounded figures that come from the tool result, with no retry", async () => {
    const { getAirport } = await import("./data");
    const atl = getAirport("ATL")!;
    scripted.push(
      toolCall("airport_profile", { iata: "ATL" }),
      answer(`Atlanta handled about ${Math.round(atl.annual_passengers / 1e6)} million passengers, down about 2 percent from 2024.`),
    );
    const res = await runAgent("How many passengers did Atlanta handle in 2025 and how did that change from 2024?");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res.reply).toMatch(/down about 2 percent/);
  });

  it("does not retry a reply with no figures, and passes the user's own numbers through", async () => {
    scripted.push(answer("Hi! I can rank airports, compare them or look at routes."));
    await runAgent("hello");
    expect(createMock).toHaveBeenCalledTimes(1);
    scripted.push(answer("Sure, top 40 it is."));
    createMock.mockClear();
    await runAgent("Show me the top 40 airports");
    expect(createMock).toHaveBeenCalledTimes(1); // "40" was in the user's message
  });
});

describe("causal wording (q46 'Why did Oakland's traffic fall')", () => {
  it("retries once and the corrected answer says what changed, not why", async () => {
    scripted.push(
      toolCall("capacity_trend", { origin: "OAK", group_by: "carrier" }),
      answer("This decline was driven by Southwest cutting seats."),
      answer("Oakland lost seats between 2024 and 2025, mostly at Southwest. The data shows what changed, not why."),
    );
    const res = await runAgent("Why did Oakland's passenger traffic fall so much in 2025?");
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(lastUserMessage(2)).toMatch(/Remove the causal wording \("driven by"\)/);
    expect(res.reply).toMatch(/not why/);
  });

  it("detects causal phrases only for 'why' questions or capacity answers", () => {
    expect(causalPhrases("It fell due to cost cutting.", { message: "Why did Oakland fall?", toolsUsed: [] })).toEqual(["due to"]);
    expect(causalPhrases("It fell due to cost cutting.", { message: "Which airports are busiest?", toolsUsed: ["rank_airports"] })).toEqual([]);
    expect(causalPhrases("Because of the hub it is busy.", { message: "How is it?", toolsUsed: ["capacity_trend"] })).toEqual(["because of"]);
  });

  it("the tool result tells the model what it may not say", async () => {
    const { runTool } = await import("./tools");
    const out = await runTool("capacity_trend", { origin: "OAK" });
    expect(String(out.result.explanation_limit)).toMatch(/what changed, not why/);
    expect(String(out.result.headline_facts)).toMatch(/seats 7,034,708 in 2024 to 6,137,508 in 2025 \(-12\.8%\)/);
  });
});

describe("refusing an answerable question (q25 Burlington delay, q29 Newark cancellations, q31 'Is Boise growing?')", () => {
  it("retries when the model says the figure is not reported and used no dataset tool", async () => {
    scripted.push(
      answer("The average departure delay at Burlington is not currently reported."),
      toolCall("airport_profile", { iata: "BTV" }),
      answer("Burlington's average departure delay was 25.4 minutes in 2025."),
    );
    const res = await runAgent("What's the average departure delay at Burlington?");
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(lastUserMessage(1)).toMatch(/dataset does answer this question/);
    expect(res.reply).toContain("25.4 minutes");
  });

  it("detects the refusal pattern precisely", () => {
    const base = { toolsUsed: [] as string[] };
    expect(refusedAnswerableQuestion("That is not currently reported.", { ...base, message: "What is the cancellation rate at Newark?" })).toBe(true);
    expect(refusedAnswerableQuestion("Live source unavailable.", { ...base, message: "Is Boise growing?" })).toBe(true);
    // A real live outage on a "right now" question, or an answer that did use the dataset, is not a refusal to fix.
    expect(refusedAnswerableQuestion("The FAA feed is unavailable.", { ...base, message: "Any delays at BOS right now?" })).toBe(false);
    expect(refusedAnswerableQuestion("not reported", { toolsUsed: ["airport_profile"], message: "What is the cancellation rate at Newark?" })).toBe(false);
    expect(refusedAnswerableQuestion("not reported", { toolsUsed: ["faa_airport_status"], message: "Delays at Newark?" })).toBe(false);
    expect(refusedAnswerableQuestion("I don't have that.", { ...base, message: "What is the population of Denver?" })).toBe(false);
  });
});

describe("the agent hands the tools the user's own message", () => {
  it("'top 3' is honoured whatever top_n the model sent", async () => {
    scripted.push(
      toolCall("rank_airports", { scope: "Pacific", user_words: "Pacific", metric: "expansion", top_n: 5 }),
      answer("Los Angeles leads the Pacific group."),
    );
    await runAgent("Best Pacific airports for expansion, top 3.");
    const toolMessage = request(1).messages.find((m) => m.role === "tool")!;
    expect((JSON.parse(toolMessage.content).ranking as unknown[]).length).toBe(3);
  });

  it("'least congested' is ranked ascending even though the model did not ask", async () => {
    scripted.push(
      toolCall("rank_airports", { scope: "all", user_words: "the country", metric: "congestion" }),
      answer("Rank one is the least congested."),
    );
    await runAgent("Which airports in the country are the least congested?");
    const result = JSON.parse(request(1).messages.find((m) => m.role === "tool")!.content);
    expect(result.order).toBe("asc");
    expect(result.ranked_first_means).toMatch(/LEAST congested/);
  });

  it("an off-topic request gets the fixed line with no model call", async () => {
    const res = await runAgent("Write me a short poem about cats.");
    expect(createMock).not.toHaveBeenCalled();
    expect(res.reply).toMatch(/outside my lane/);
    expect(res.meta?.timings?.model_calls).toBe(0);
    expect(res.meta?.tools_used).toEqual([]);
  });
});

describe("the prompt carries the new rules and the dataset facts", () => {
  const prompt = systemPrompt("model");

  it("maps single-airport figures to airport_profile and defines 'growing' and 'bigger'", () => {
    expect(prompt).toMatch(/call airport_profile and quote its facts_summary or metrics exactly/);
    expect(prompt).toMatch(/"growing" means passenger growth and "bigger" means passenger volume, never population/);
    expect(prompt).toMatch(/faa_airport_status is ONLY for "right now"/);
    expect(prompt).toMatch(/For "in 2025", "2025 vs 2024" or "last year" use airport_profile/);
    expect(prompt).toMatch(/never bts_airport_traffic/);
  });

  it("covers order, carriers, named airports, scope and the population wording", () => {
    expect(prompt).toMatch(/pass order='asc'/);
    expect(prompt).toMatch(/Pass the number the user asked for/);
    expect(prompt).toMatch(/pass it as carrier to capacity_trend or route_search/);
    expect(prompt).toMatch(/Never add a carrier or destination filter the user did not name/);
    expect(prompt).toMatch(/Never choose between them yourself/);
    expect(prompt).toMatch(/You only discuss U\.S\. airport analysis/);
    expect(prompt).toMatch(/population isn't part of this demo/);
  });

  it("states the dataset facts generated from the data, and keeps the old rules", () => {
    expect(prompt).toMatch(/Dataset facts \(use these for any question about coverage, sources, freshness or method\): The dataset covers 102 U\.S\. airports/);
    expect(prompt).toMatch(/93\.9% of all U\.S\. scheduled passenger enplanements/);
    expect(prompt).toMatch(/NEVER invent routes, carriers or figures/);
    expect(prompt).toMatch(/Never call a route, market or airport "underserved" or "well-served"/);
    expect(prompt).toMatch(/Two to four sentences/);
    expect(prompt).toMatch(/Never walk through rows/);
  });
});

describe("helpers", () => {
  it("builds a factual reply only from sentences the tools wrote", () => {
    const outputs = [{ result: { facts_summary: "ATL, calendar year 2025: 51,483,324 enplaned passengers." } }, { result: { headline_facts: "OAK: seats fell." } }];
    expect(factualReply(outputs, true)).toBe("ATL, calendar year 2025: 51,483,324 enplaned passengers. OAK: seats fell. The table has the full detail.");
    expect(factualReply([{ result: { ranking: [] } }], true)).toBeUndefined();
  });

  it("removes only the sentences with causal wording when there is nothing else to say", () => {
    expect(withoutCausalSentences("Seats fell. It was driven by costs. Spirit left.", ["driven by"])).toBe("Seats fell. Spirit left.");
  });

  it("reads figures with their scale", () => {
    expect(parseFigure("5.3 million")).toEqual({ value: 5.3e6, place: 1e5, percent: false });
    expect(parseFigure("906000")).toMatchObject({ value: 906000, place: 1000 });
    expect(parseFigure("12.8%")).toMatchObject({ value: 12.8, percent: true });
  });
});
