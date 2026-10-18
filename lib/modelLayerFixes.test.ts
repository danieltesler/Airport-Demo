/**
 * Code-level fixes for what a real model got wrong in the paid test, replayed from
 * test/fixtures/phrasings.ts: the tools must do the right thing even when the model's own
 * arguments are wrong or missing.
 */

import { describe, expect, it } from "vitest";
import * as data from "./data";
import { PHRASINGS, type PhrasingCase } from "../test/fixtures/phrasings";
import { collapseSpelledLetters } from "./spelledCodes";
import { namedAirports } from "./namedAirports";
import { findCarrier } from "./carriers";
import { requestedCount, requestedOrder } from "./requestedCount";
import { offTopicReply, OFF_TOPIC_REPLY } from "./offTopic";
import { runTool } from "./tools";

const phrasing = (id: string): PhrasingCase => PHRASINGS.find((p) => p.id === id)!;
/** Run a recorded phrasing the way the agent does: the user's message rides along as user_message. */
const replay = (id: string) => {
  const p = phrasing(id);
  return runTool(p.tool, { ...p.args, user_message: p.message });
};
const codes = (out: { result: Record<string, unknown> }, key = "comparison"): string[] =>
  (out.result[key] as { iata: string }[]).map((c) => c.iata).sort();
const rows = (out: { structured?: { rows: unknown[][] } | null }) => out.structured!.rows;

describe("1. named airports in the user's words beat the model's own arguments", () => {
  it("'Portland Oregon and Seattle' compares PDX and SEA, not an improvised Washington scope", async () => {
    const out = await replay("q01-portland-oregon");
    expect(codes(out)).toEqual(["PDX", "SEA"]);
    expect(String(out.result.scope_note)).toMatch(/Compared exactly the airports named: PDX, SEA/);
    expect(String(out.result.scope_note)).toMatch(/instead of the scope 'Washington'/);
    expect(out.structured?.caption).toBe("Comparing 2 airports: PDX, SEA · congestion score");
  });

  it("reads City State, City, State and City ST forms", () => {
    for (const words of ["Portland Oregon and Seattle", "Portland, Oregon and Seattle", "Portland OR and Seattle", "Portland, OR and Seattle", "Portland, OR, and Seattle"]) {
      const named = namedAirports(words);
      expect(named?.kind, words).toBe("airports");
      expect(named && named.kind === "airports" ? named.airports.map((a) => a.iata).sort() : [], words).toEqual(["PDX", "SEA"]);
    }
    const maine = namedAirports("Portland Maine and Boston");
    expect(maine?.kind === "airports" && maine.airports.map((a) => a.iata).sort()).toEqual(["BOS", "PWM"]);
    expect(namedAirports("Portland and Seattle")?.kind).toBe("ambiguous");
  });

  it("uses the user's words over passed iatas that disagree, and says so", async () => {
    const out = await runTool("compare_airports", { iatas: ["GEG", "SEA"], user_words: "Portland Oregon and Seattle" });
    expect(codes(out)).toEqual(["PDX", "SEA"]);
    expect(String(out.result.scope_note)).toMatch(/instead of GEG, SEA/);
  });

  it("falls back to the whole user message when the model sent no user_words at all", async () => {
    const out = await runTool("compare_airports", { scope: "Washington", user_message: "Compare Portland Oregon and Seattle congestion" });
    expect(codes(out)).toEqual(["PDX", "SEA"]);
  });
});

describe("8. ambiguity cannot be bypassed and spelled-out codes are read", () => {
  it("'Dallas and Austin' asks even though the model already picked DFW and AUS", async () => {
    const out = await replay("q08-dallas-austin");
    expect(out.result).toMatchObject({ status: "ambiguous" });
    expect((out.result.options as { scope: string }[]).map((o) => o.scope).sort()).toEqual(["DAL", "DFW"]);
    expect(out.structured).toBeUndefined();
  });

  it("does not ask when the user said the codes themselves", async () => {
    const out = await runTool("compare_airports", { iatas: ["DFW", "AUS"], user_words: "DFW and AUS", metric: "congestion" });
    expect(codes(out)).toEqual(["AUS", "DFW"]);
  });

  it("collapses spelled-out letters from a voice transcript", () => {
    expect(collapseSpelledLetters("Compare L A X and S N A")).toBe("Compare LAX and SNA");
    expect(collapseSpelledLetters("J.F.K. versus E-W-R")).toBe("JFK versus EWR");
    expect(collapseSpelledLetters("a big airport")).toBe("a big airport");
  });

  it("'Compare L A X and Santa Ana' compares LAX and SNA only, not the Los Angeles metro", async () => {
    const out = await replay("q15-spelled-lax");
    expect(codes(out)).toEqual(["LAX", "SNA"]);
    expect(out.structured?.rows).toHaveLength(2);
  });

  it("reads a spelled-out code in an iatas argument too", async () => {
    const out = await runTool("compare_airports", { iatas: ["L A X", "S N A"], metric: "congestion" });
    expect(codes(out)).toEqual(["LAX", "SNA"]);
  });
});

describe("2. ranking direction", () => {
  it("'least congested' ranks ascending and says rank 1 is the least congested", async () => {
    const out = await replay("q13-least-congested");
    expect(out.result.order).toBe("asc");
    expect(String(out.result.ranked_first_means)).toMatch(/LEAST congested/);
    const scores = (out.result.ranking as { score: number }[]).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    const mostCongested = (await runTool("rank_airports", { scope: "all", metric: "congestion", top_n: 1 })).result.ranking as { iata: string }[];
    expect((out.result.ranking as { iata: string }[]).map((r) => r.iata)).not.toContain(mostCongested[0].iata);
    expect(out.structured?.caption).toMatch(/lowest first$/);
  });

  it("an explicit order argument works, and the default stays descending", async () => {
    const asc = await runTool("rank_airports", { scope: "all", metric: "expansion", order: "asc", top_n: 3 });
    expect(String(asc.result.ranked_first_means)).toMatch(/WEAKEST/);
    const desc = await runTool("rank_airports", { scope: "all", metric: "congestion", top_n: 3 });
    expect(desc.result.order).toBe("desc");
    expect(String(desc.result.ranked_first_means)).toMatch(/MOST congested/);
    expect(desc.structured?.caption).not.toMatch(/lowest first/);
  });

  it("the user's words beat a model that sent desc for 'least'", async () => {
    const out = await runTool("rank_airports", { scope: "all", metric: "congestion", order: "desc", user_message: "Which airport has the fewest delays?" });
    expect(out.result.order).toBe("asc");
  });

  it("'at least' is not a request for the least", () => {
    expect(requestedOrder("airports with at least 10 million passengers")).toBeNull();
    expect(requestedOrder("the least congested airports")).toBe("asc");
  });
});

describe("10. 'top N' in the user's words", () => {
  it("returns 3 rows for 'top 3' even when the model sent 5 or nothing", async () => {
    for (const id of ["q05-top-3", "q11-top-3"]) {
      const out = await replay(id);
      expect(out.structured?.rows, id).toHaveLength(3);
      expect(out.structured?.caption, id).toMatch(/top 3 by/);
    }
  });

  it("reads the common phrasings and caps by tool", async () => {
    expect(requestedCount("top 3 airports")).toBe(3);
    expect(requestedCount("the 4 busiest")).toBe(4);
    expect(requestedCount("best three")).toBe(3);
    expect(requestedCount("Top five most congested")).toBe(5);
    expect(requestedCount("how many airports are there")).toBeNull();
    const routes = await runTool("route_search", { origin: "BOS", user_message: "top 4 routes from Boston" });
    expect(routes.result.returned).toBe(4);
    const capped = await runTool("rank_airports", { scope: "all", metric: "expansion", user_message: "top 99 airports" });
    expect((capped.result.ranking as unknown[]).length).toBe(25);
  });
});

describe("5. carrier filter and exact attribution", () => {
  it("Southwest at Oakland: the airline is read from the user's message even when the model forgot it", async () => {
    const out = await replay("q34-southwest-at-oakland"); // the model sent no carrier
    expect(out.result.filters_applied).toEqual(["carrier: Southwest Airlines (WN)"]);
    expect(out.result.carriers_included).toBe("Southwest Airlines (WN)");
    expect(String(out.result.carrier_note)).toMatch(/taken from the user's own message/);
    const totals = out.result.totals as Record<string, number>;
    expect(totals.seats_change).toBe(-710743);
    expect(totals.seats_change_pct).toBe(-12.9);
    expect(String(out.result.totals_scope)).toBe("Southwest Airlines (WN), all destinations from OAK");
    expect(out.structured?.rows[0][1]).toBe("Southwest Airlines (WN), all destinations from OAK");
    expect(out.structured?.caption).toBe("Capacity trend, Southwest Airlines (WN) flights from OAK · 2024 to 2025 · biggest changes by carrier");
    expect(String(out.result.describe_exactly)).toMatch(/exactly that scope/);
    expect(String(out.result.headline_facts)).toMatch(/^Southwest Airlines \(WN\), all destinations from OAK: seats 5,511,216 in 2024 to 4,800,473 in 2025 \(-12.9%\)/);
  });

  it("Spirit at Oakland is Spirit's -303,858 seats (-60.1%), not the airport's -12.8%", async () => {
    const out = await replay("q42-spirit-at-oakland");
    const totals = out.result.totals as Record<string, number>;
    expect(totals.seats_change).toBe(-303858);
    expect(totals.seats_change_pct).toBe(-60.1);
  });

  it("an explicit carrier argument still works when the message names none", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK", carrier: "Southwest", group_by: "destination" });
    expect(out.result.filters_applied).toEqual(["carrier: Southwest Airlines (WN)"]);
    expect((out.result.totals as Record<string, number>).seats_change).toBe(-710743);
  });

  it("the user's named airline beats a different carrier the model passed", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK", carrier: "Delta", user_message: "How much did Spirit cut at Oakland?" });
    expect(out.result.filters_applied).toEqual(["carrier: Spirit Airlines (NK)"]);
  });

  it("Delta at Atlanta is Delta's own change, not the airport total", async () => {
    const delta = await runTool("capacity_trend", { origin: "ATL", user_message: "Did Delta add seats at Atlanta?" });
    const airport = await runTool("capacity_trend", { origin: "ATL" });
    expect(delta.result.filters_applied).toEqual(["carrier: Delta Air Lines (DL)"]);
    expect((delta.result.totals as Record<string, number>).seats_change).not.toBe((airport.result.totals as Record<string, number>).seats_change);
  });

  it("a question that names no airline says the figures are for all airlines combined", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK", user_message: "How did Oakland change?" });
    expect(out.result.carriers_included).toBe("all airlines combined");
    expect(String(out.result.all_airlines_note)).toMatch(/ALL airlines combined/);
    expect(String(out.result.totals_scope)).toBe("all airlines, all destinations from OAK");
    expect(out.structured?.caption).toContain("Capacity trend, all airlines flights from OAK");
  });

  it("three airlines named together make ONE combined table, so the screen matches the answer", async () => {
    const message = PHRASINGS.find((p) => p.id === "q35-unrequested-destination")!.message;
    const out = await runTool("capacity_trend", { origin: "OAK", group_by: "carrier", user_message: message });
    expect(out.result.filters_applied).toEqual(["carrier: Southwest Airlines (WN), Spirit Airlines (NK) and Delta Air Lines (DL)"]);
    expect(out.result.group_by).toBe("carrier");
    const labels = out.structured!.rows.map((r) => String(r[1])).join("|");
    for (const wanted of ["Southwest Airlines (WN)", "Spirit Airlines (NK)", "Delta Air Lines (DL)"]) expect(labels).toContain(wanted);
    expect(out.structured!.rows.length).toBeGreaterThanOrEqual(4); // total + three airlines
    // Even with the stray destination filter the model added, the airlines all show and the filter is stated.
    const withStray = await replay("q35-unrequested-destination");
    expect(withStray.result.filters_applied).toEqual([
      "carrier: Southwest Airlines (WN), Spirit Airlines (NK) and Delta Air Lines (DL)",
      "destination: LAS — Las Vegas",
    ]);
  });

  it("the airport total is still the airport's total when no carrier is named", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK" });
    expect((out.result.totals as Record<string, number>).seats_change).toBe(-897200);
    expect(out.result.filters_applied).toEqual([]);
  });

  it("finds carriers by code, name or distinctive word and refuses to guess", () => {
    expect(findCarrier("WN")).toMatchObject({ ok: true, code: "WN" });
    expect(findCarrier("southwest")).toMatchObject({ ok: true, code: "WN" });
    expect(findCarrier("Southwest Airlines")).toMatchObject({ ok: true, code: "WN" });
    expect(findCarrier("Spirit")).toMatchObject({ ok: true, code: "NK" });
    expect(findCarrier("Delta")).toMatchObject({ ok: true, code: "DL" });
    expect(findCarrier("Air Canada")).toMatchObject({ ok: true, code: "AC" });
    expect(findCarrier("Zebra Air")).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("reports an unknown carrier plainly, and applies the filter to route_search too", async () => {
    const unknown = await runTool("capacity_trend", { origin: "OAK", carrier: "Zebra Air" });
    expect(String(unknown.result.error)).toMatch(/I don't have a carrier called 'Zebra Air'/);
    const routes = await runTool("route_search", { origin: "OAK", carrier: "Spirit", top_n: 3 });
    expect(routes.result.filters_applied).toEqual(["carrier: Spirit Airlines (NK)"]);
    expect(routes.structured?.caption).toContain("only Spirit Airlines (NK)");
    for (const route of routes.result.routes as { carriers: { code: string }[] }[]) {
      expect(route.carriers.every((c) => c.code === "NK")).toBe(true);
    }
  });

  it("states a destination filter the model added, so the reply cannot hide it", async () => {
    const out = await runTool("capacity_trend", { origin: "OAK", destination: "LAS", group_by: "carrier", user_message: "Which airlines cut seats at Oakland?" });
    expect(out.result.filters_applied).toEqual(["destination: LAS — Las Vegas"]);
    expect(String(out.result.describe_exactly)).toMatch(/never add a filter the user did not ask for/);
    expect(out.structured?.caption).toContain("to LAS — Las Vegas");
  });

  it("a no-service answer names the carrier filter", async () => {
    const out = await runTool("route_search", { origin: "BTV", carrier: "Spirit", destination: "SEA" });
    expect(String(out.result.message)).toMatch(/by Spirit Airlines \(NK\)/);
    expect(out.result.filters_applied).toEqual(["carrier: Spirit Airlines (NK)", "destination: SEA — Seattle"]);
  });
});

describe("3. airport_profile carries labelled periods and ready figures", () => {
  it("JFK: international passengers as a number, labelled calendar year", async () => {
    const out = await runTool("airport_profile", { iata: "JFK" });
    const metrics = out.result.metrics as Record<string, number>;
    const jfk = data.getAirport("JFK")!;
    expect(metrics.international_passengers).toBe(17009706); // the exact BTS count, not the rounded share times passengers
    expect(jfk.international_passengers).toBe(17009706);
    expect(metrics.international_passenger_share_pct).toBeCloseTo(54.8, 1);
    expect(String(out.result.period)).toMatch(/calendar year 2025/);
    expect(String(out.result.period)).toMatch(/Not a live or trailing-12-month figure/);
    expect(String(out.result.facts_summary)).toMatch(/^JFK, calendar year 2025: .*enplaned passengers; .* of them international \(54\.8%\)/);
  });

  it("Atlanta growth is a signed percentage with a direction", async () => {
    const out = await runTool("airport_profile", { iata: "ATL" });
    const metrics = out.result.metrics as Record<string, unknown>;
    expect(metrics.pax_growth_pct).toBeCloseTo(-2.1, 1);
    expect(metrics.pax_growth_direction).toBe("down");
    expect(String(out.result.facts_summary)).toMatch(/passengers down 2\.1% from 2024/);
  });

  it("Burlington delay, Newark cancellations and Boise growth are in the profile (the figures the model refused to give)", async () => {
    const btv = (await runTool("airport_profile", { iata: "BTV" })).result.metrics as Record<string, number>;
    expect(btv.avg_dep_delay_min).toBeCloseTo(25.4, 1);
    const ewr = (await runTool("airport_profile", { iata: "EWR" })).result.metrics as Record<string, number>;
    expect(ewr.cancel_rate_pct).toBeCloseTo(2.5, 1);
    const boi = (await runTool("airport_profile", { iata: "BOI" })).result.metrics as Record<string, number>;
    expect(boi.pax_growth_pct).toBeCloseTo(4.2, 1);
  });
});

describe("6. dataset facts come from the data", () => {
  it("states the airport count and national share from the meta block", () => {
    const facts = data.datasetFacts();
    expect(facts).toContain(`${data.allAirports().length} U.S. airports`);
    expect(facts).toMatch(/93\.9% of all U\.S\. scheduled passenger enplanements/);
    expect(facts).toMatch(/calendar year 2025, with 2024 for comparison/);
    expect(facts).toMatch(/BTS T-100/);
    expect(facts).toMatch(/not a live feed/);
  });
});

describe("7. off-topic requests are refused by code", () => {
  it("answers a poem request with the fixed friendly line, no model needed", () => {
    expect(offTopicReply("Write me a short poem about cats.")).toBe(OFF_TOPIC_REPLY);
    expect(offTopicReply("tell me a joke")).toBe(OFF_TOPIC_REPLY);
    expect(offTopicReply("Give me a recipe for lasagna")).toBe(OFF_TOPIC_REPLY);
  });

  it("never intercepts anything about airports", () => {
    expect(offTopicReply("Write a short story about an airport")).toBeNull();
    expect(offTopicReply("Write a poem comparing LAX and SNA")).toBeNull();
    expect(offTopicReply("What is a good recipe for airport congestion?")).toBeNull();
    expect(offTopicReply("Compare Boston and Chicago")).toBeNull();
    expect(offTopicReply("Which flights are delayed?")).toBeNull();
  });
});

describe("9. Census wording", () => {
  it("says the source is not set up in this demo, with no figure", async () => {
    const saved = process.env.CENSUS_API_KEY;
    delete process.env.CENSUS_API_KEY;
    try {
      const out = await runTool("metro_population", { iata: "DEN" });
      expect(String(out.result.message)).toMatch(/not set up in this demo/);
      expect(String(out.result.fallback)).toMatch(/not set up in this demo/);
      expect(String(out.result.fallback)).toMatch(/not that a live source is down|do not say it is 'unavailable right now'/);
      expect(out.result.do_not_estimate).toBe(true);
    } finally {
      if (saved !== undefined) process.env.CENSUS_API_KEY = saved;
    }
  });
});

describe("12. live BTS growth carries its sign and period", () => {
  it("states a signed percentage, a direction and the trailing window", async () => {
    const { btsAirportTraffic } = await import("./live/btsTraffic");
    const { fixture, makeDeps, mockFetch, resetLiveState } = await import("./live/testing");
    resetLiveState();
    const mock = mockFetch([["data.bts.gov", { body: fixture("bts-t100-bos.real.json") }]]);
    const out = await btsAirportTraffic({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    const growth = out.result.passenger_growth_yoy as number;
    expect(out.result.passenger_growth_pct).toBe(Math.round(growth * 1000) / 10);
    expect(out.result.passenger_growth_direction).toBe(growth > 0 ? "up" : growth < 0 ? "down" : "flat");
    expect(String(out.result.period_label)).toMatch(/^trailing 12 months, \d{4}-\d{2} to \d{4}-\d{2}: this is not a calendar year/);
    expect(String(out.result.period_label)).toMatch(/never label it 2025/);
  });
});

describe("named cities with multi-word states", () => {
  it("reads 'Raleigh, North Carolina and Boston'", () => {
    const named = namedAirports("Raleigh, North Carolina and Boston");
    expect(named?.kind === "airports" && named.airports.map((a) => a.iata).sort()).toEqual(["BOS", "RDU"]);
  });
});
