/**
 * Second round of fixes after the real-model re-run: false positives of the reply check, calendar-year
 * routing, clarifying-question follow-ups, off-topic false refusals, exact counts and spoken names.
 */

import { describe, expect, it, vi } from "vitest";

const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async (_args?: unknown) => ({ choices: [{ message: queue.shift() }] })) };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import * as data from "./data";
import { runAgent } from "./agent";
import { asksForCalendarYear } from "./calendarYear";
import { effectiveMessage } from "./followUp";
import { offTopicReply } from "./offTopic";
import { carriersNamedIn } from "./carriers";
import { causalPhrases, findReplyIssues, unsupportedFigures, type ReplyContext } from "./replyCheck";
import { requestedCount } from "./requestedCount";
import { speakableAirportNames } from "./speakable";
import { runTool } from "./tools";

const context = (overrides: Partial<ReplyContext> & { outputs: unknown[] }): ReplyContext => ({
  message: "question",
  priorContext: "",
  staticFacts: data.documentedConstants(),
  toolsUsed: [],
  ...overrides,
});

describe("reply check no longer flags the documented constants and sensible roundings", () => {
  it("documents the constants from the data's own metadata", () => {
    const constants = data.documentedConstants();
    for (const value of [15, 100, 93.9, 93.87, 5000, 365, 1100, 2200, 12, 102]) expect(constants).toContain(value);
  });

  it("accepts the delay threshold and the coverage figures with no tool result", () => {
    const reply = "Flights delayed 15 minutes or more are counted. The dataset covers the 100 busiest airports plus two more, 93.9% of U.S. traffic, 102 airports in all.";
    expect(unsupportedFigures(reply, context({ outputs: [] }))).toEqual([]);
  });

  it("accepts millions and thousands that round a grounded value", async () => {
    const trend = await runTool("capacity_trend", { origin: "OAK" });
    for (const reply of [
      "Oakland had 5.3 million passengers in 2024.",
      "Oakland had 5.2 million passengers in 2024.", // truncated, within one step
      "Oakland had 4.5 million passengers in 2025.",
      "Oakland had 7,034,708 seats in 2024.",
    ]) {
      expect(unsupportedFigures(reply, context({ outputs: [trend] })), reply).toEqual([]);
    }
  });

  it("reads '7034708 in 2024' as a figure and a year, not as a ratio of two figures", async () => {
    const trend = await runTool("capacity_trend", { origin: "OAK" });
    const reply = "Oakland went from 7034708 in 2024 to 6137508 in 2025.";
    expect(unsupportedFigures(reply, context({ outputs: [trend] }))).toEqual([]);
  });

  it("finds a raw count that rounds a grounded one (906000 for 906,213)", () => {
    const outputs = [{ result: { passengers: 906213 } }];
    expect(unsupportedFigures("About 906000 passengers flew it.", context({ outputs }))).toEqual([]);
  });

  it("still flags a figure that is not a rounding of anything (the invented 450,000, 12.5 million)", async () => {
    const trend = await runTool("capacity_trend", { origin: "OAK" });
    expect(unsupportedFigures("This meant about 450,000 fewer passengers.", context({ outputs: [trend] }))).toContain("450000");
    const jfk = await runTool("airport_profile", { iata: "JFK" });
    expect(unsupportedFigures("About 12.5 million were international.", context({ outputs: [jfk] }))).toEqual(["12.5 million"]);
  });

  it("reads the LAX delay (13.82) from the compare result", async () => {
    const compare = await runTool("compare_airports", { iatas: ["LAX", "SNA"], metric: "congestion" });
    expect(unsupportedFigures("LAX has an average departure delay of 13.82 minutes.", context({ outputs: [compare] }))).toEqual([]);
  });
});

describe("causal wording list", () => {
  it("catches led to, contributed to and resulted in", () => {
    const ctx = { message: "Why did Oakland fall?", toolsUsed: ["capacity_trend"] };
    for (const phrase of ["This led to fewer seats.", "Southwest contributed to the drop.", "Cuts resulted in fewer passengers.", "It reflects a strategy shift."]) {
      expect(causalPhrases(phrase, ctx), phrase).not.toEqual([]);
    }
    expect(causalPhrases("Seats fell 12.8 percent.", ctx)).toEqual([]);
  });

  it("is enforced after the retry: the shipped reply is built from the tool facts and says not why", async () => {
    const answer = (reply: string) => ({ role: "assistant", content: JSON.stringify({ reply, spoken: "Seats fell." }) });
    const toolCall = (name: string, args: object) => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    scripted.length = 0;
    createMock.mockClear();
    scripted.push(toolCall("capacity_trend", { origin: "OAK" }), answer("The decline was driven by Southwest."), answer("The decline was driven by Southwest."));
    const res = await runAgent("Why did Oakland's traffic fall?");
    expect(res.reply).not.toMatch(/driven by/i);
    expect(res.reply).toMatch(/^all airlines, all destinations from OAK: seats 7,034,708 in 2024 to 6,137,508 in 2025/);
    expect(res.reply).toMatch(/The data shows what changed, not why\.$/);
  });
});

describe("2. calendar-year questions use calendar-year figures", () => {
  it("recognises the phrasings", () => {
    for (const message of ["How many passengers did Atlanta handle in 2025 and how did that change from 2024?", "Atlanta 2025 vs 2024", "How many people flew out of Nashville last year?", "What was Boise's growth in 2025?"]) {
      expect(asksForCalendarYear(message), message).toBe(true);
    }
    for (const message of ["How is traffic at Atlanta lately?", "Latest trailing 12 months for BOS in 2025", "Any delays at JFK right now?"]) {
      expect(asksForCalendarYear(message), message).toBe(false);
    }
  });

  it("answers from airport_profile when the model reaches for the live trailing summary", async () => {
    const out = await runTool("bts_airport_traffic", { iata: "ATL", user_message: "How many passengers did Atlanta handle in 2025 and how did that change from 2024?" });
    expect(out.result.substituted_for).toBe("bts_airport_traffic");
    expect(String(out.result.period)).toMatch(/calendar year 2025/);
    expect((out.result.metrics as Record<string, number>).annual_passengers).toBe(51483324);
    expect((out.result.metrics as Record<string, number>).pax_growth_pct).toBeCloseTo(-2.1, 1);
    expect((out.result.metrics as Record<string, number>).passengers_prior_year).toBe(data.getAirport("ATL")!.previous_year_passengers);
    expect(String(out.result.substitution_note)).toMatch(/trailing 12 months/);
  });

  it("keeps the live summary for a 'recent' question", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    try {
      const out = await runTool("bts_airport_traffic", { iata: "ATL", user_message: "How is traffic at Atlanta lately?" });
      expect(out.result.substituted_for).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("flags a reply that labels live trailing figures as a calendar year (backstop)", () => {
    const issues = findReplyIssues("Atlanta handled 51.4 million passengers in 2025, down from 2024.", context({
      outputs: [{ result: { trailing_12_months: { enplaned_passengers: 51400000 } } }],
      message: "How many passengers did Atlanta handle in 2025?",
      toolsUsed: ["bts_airport_traffic"],
    }));
    expect(issues.some((issue) => issue.kind === "period")).toBe(true);
    expect(findReplyIssues("Atlanta handled 51.4 million passengers in 2025.", context({ outputs: [{ result: { a: 51400000 } }], toolsUsed: ["airport_profile"] })).some((i) => i.kind === "period")).toBe(false);
  });
});

describe("7. exact counts replace derived ones", () => {
  it("stores the exact international count and prior-year passengers", () => {
    expect(data.getAirport("JFK")!.international_passengers).toBe(17009706);
    expect(data.getAirport("BNA")!.previous_year_passengers).toBe(12111413);
  });

  it("the profile quotes them, so nothing is derived from a rounded share or growth", async () => {
    const jfk = (await runTool("airport_profile", { iata: "JFK" })).result;
    expect((jfk.metrics as Record<string, number>).international_passengers).toBe(17009706);
    const bna = await runTool("airport_profile", { iata: "BNA" });
    expect((bna.result.metrics as Record<string, number>).passengers_prior_year).toBe(12111413);
    expect(String(bna.result.facts_summary)).toContain("(12,111,413 in 2024)");
  });
});

describe("5. follow-ups to a clarifying question", () => {
  const history = (shown = "Table (none). Options offered to the user: DFW — Dallas-Fort Worth (scope: DFW); DAL — Dallas (scope: DAL).") => [
    { role: "user" as const, content: "Compare Dallas and Austin on congestion." },
    { role: "assistant" as const, content: "Which Dallas airport, Dallas-Fort Worth or Love Field?", shown },
  ];

  it("'DFW please', 'use DFW', 'Love Field' and 'Fort Worth' rebuild the original question", () => {
    expect(effectiveMessage("DFW please", history())).toBe("Compare DFW and Austin on congestion.");
    expect(effectiveMessage("use DFW", history())).toBe("Compare DFW and Austin on congestion.");
    expect(effectiveMessage("D F W", history())).toBe("Compare DFW and Austin on congestion.");
    expect(effectiveMessage("Love Field", history())).toBe("Compare DAL and Austin on congestion.");
    expect(effectiveMessage("the Fort Worth one", history())).toBe("Compare DFW and Austin on congestion.");
  });

  it("leaves other messages alone, and does nothing without offered options", () => {
    expect(effectiveMessage("What about Houston?", history())).toBe("What about Houston?");
    expect(effectiveMessage("DFW please", history("Table (ranking). Rows in order: 1 DFW — Dallas-Fort Worth."))).toBe("DFW please");
    expect(effectiveMessage("DFW please", [])).toBe("DFW please");
  });

  it("the compare tool then compares exactly DFW and AUS", async () => {
    const message = effectiveMessage("DFW please", history());
    const out = await runTool("compare_airports", { metric: "congestion", user_words: "DFW", user_message: message });
    expect((out.result.comparison as { iata: string }[]).map((c) => c.iata).sort()).toEqual(["AUS", "DFW"]);
  });

  it("a bare 'Dallas and Austin' still asks, even when the model chose DFW and rewrote the words", async () => {
    const out = await runTool("compare_airports", { iatas: ["DFW", "AUS"], user_words: "Dallas-Fort Worth and Austin", user_message: "Compare Dallas and Austin" });
    expect(out.result).toMatchObject({ status: "ambiguous" });
  });

  it("through the agent, the tool call receives the rebuilt request", async () => {
    scripted.length = 0;
    createMock.mockClear();
    scripted.push(
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "compare_airports", arguments: JSON.stringify({ metric: "congestion", user_words: "DFW" }) } }] },
      { role: "assistant", content: JSON.stringify({ reply: "Austin is a bit calmer.", spoken: "Austin is calmer." }) },
    );
    const res = await runAgent("DFW please", history());
    expect(res.structured?.caption).toBe("Comparing 2 airports: AUS, DFW · congestion score");
  });
});

describe("5. 'the single best airport' is one row", () => {
  it("reads singular superlatives as one", () => {
    expect(requestedCount("The single best airport in California")).toBe(1);
    expect(requestedCount("What is the most congested airport in the Midwest?")).toBe(1);
    expect(requestedCount("the busiest airport in Texas")).toBe(1);
    expect(requestedCount("best airports for expansion")).toBeNull();
    expect(requestedCount("top 3 airports")).toBe(3);
  });

  it("ranks exactly one airport", async () => {
    const out = await runTool("rank_airports", { scope: "California", metric: "expansion", user_message: "The single best airport in California" });
    expect(out.structured?.rows).toHaveLength(1);
  });
});

describe("6. off-topic words next to an airport are not refused", () => {
  it("lets airport questions through, however they are phrased", () => {
    for (const message of [
      "Tell me the story about Oakland's traffic",
      "Joke aside, how congested is Denver?",
      "Write an essay on Boise's growth",
      "Any lyrics-free summary of Hartford vs Burlington?",
    ]) {
      expect(offTopicReply(message), message).toBeNull();
    }
  });

  it("still refuses plain off-topic requests", () => {
    for (const message of ["Write me a short poem about cats.", "Tell me a joke", "Give me a recipe for lasagna", "Write an essay on the French Revolution", "Write a poem about Southwest's flying"]) {
      expect(offTopicReply(message), message).not.toBeNull();
    }
  });
});

describe("8. spoken lines say names, not codes", () => {
  it("replaces codes by city names, including possessives and parenthesised codes", () => {
    expect(speakableAirportNames("LAX's delay is shorter than SNA's.")).toBe("Los Angeles's delay is shorter than Santa Ana's.");
    expect(speakableAirportNames("Los Angeles (LAX) leads.")).toBe("Los Angeles leads.");
    expect(speakableAirportNames("Boston is steady.")).toBe("Boston is steady.");
  });

  it("keeps the codes when two airports share a city, so they can be told apart", () => {
    expect(speakableAirportNames("JFK and LGA are both busy.")).toBe("JFK and LGA are both busy.");
  });
});

describe("1. airlines the user names", () => {
  it("finds airlines by name only, never by a two-letter code, and not the state or the country", () => {
    expect(carriersNamedIn("How did Southwest's flying at Oakland change?").map((c) => c.code)).toEqual(["WN"]);
    expect(carriersNamedIn("Southwest, Spirit, Delta").map((c) => c.code).sort()).toEqual(["DL", "NK", "WN"]);
    expect(carriersNamedIn("Did Alaska Airlines add seats?").map((c) => c.code)).toEqual(["AS"]);
    expect(carriersNamedIn("Best airports in Alaska")).toEqual([]);
    expect(carriersNamedIn("the United States")).toEqual([]);
    expect(carriersNamedIn("Air Canada Rouge flights").map((c) => c.code)).toEqual(["RV"]);
    expect(carriersNamedIn("WN and AA")).toEqual([]);
  });
});

describe("calendar-year answers from a substituted tool are not flagged as live figures", () => {
  it("counts the substituted profile as a dataset tool, so a correct calendar-year reply is not retried", async () => {
    scripted.length = 0;
    createMock.mockClear();
    const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bts_airport_traffic", arguments: JSON.stringify({ iata: "ATL" }) } }] };
    const reply = "In 2025 Atlanta handled 51,483,324 passengers, down 2.1 percent from 2024.";
    scripted.push(call, { role: "assistant", content: JSON.stringify({ reply, spoken: "Atlanta was down about 2 percent." }) });
    const res = await runAgent("How many passengers did Atlanta handle in 2025 and how did that change from 2024?");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res.reply).toBe(reply);
    expect(res.meta?.tools_used).toEqual(["airport_profile"]);
  });
});

describe("rounding of a bare whole number", () => {
  it("accepts 'over 30' for 31.7 but not 'about 45' for 31.7", () => {
    const outputs = [{ result: { seats_change_pct: -31.7 } }];
    expect(unsupportedFigures("Seats were cut by over 30 percent.", context({ outputs }))).toEqual([]);
    expect(unsupportedFigures("Seats were cut by about 45 percent.", context({ outputs }))).toEqual(["45"]);
  });
});

describe("totals say whose they are", () => {
  it("states that an airline's totals are not the airport's", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK", user_message: "Southwest, Spirit and Delta at Oakland" });
    expect(String(out.result.totals_note)).toMatch(/cover only Southwest Airlines \(WN\), Spirit Airlines \(NK\) and Delta Air Lines \(DL\), not the whole airport/);
    const airport = await runTool("capacity_trend", { origin: "OAK" });
    expect(String(airport.result.totals_note)).toMatch(/all airlines combined/);
  });
});
