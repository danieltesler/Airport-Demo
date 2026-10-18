import { describe, expect, it } from "vitest";
import * as data from "./data";
import { airportProfile, compareAirports, longHaulBreakdown, rankAirports, unmetDemand } from "./tools";

/**
 * End-to-end checks for the four sample analyst questions, exercised through the
 * tools (the LLM layer is not involved — these assert the deterministic answers).
 */
describe("sample questions via tools", () => {
  it("ranks New England expansion candidates in score order, all from New England", () => {
    // With the hand-curated file Boston ranked first. With real 2025 BTS data Boston's traffic
    // is flat (-0.8%) while Burlington grew 5.7% and had the region's worst delays, so the
    // assertion is now the ranking's own consistency, not a named winner.
    const out = rankAirports("new_england", "expansion", 6);
    const ranking = out.result.ranking as Array<{ iata: string; score: number }>;
    expect(ranking.map((r) => r.iata).sort()).toEqual(["BDL", "BOS", "BTV", "MHT", "PVD", "PWM"]);
    for (let i = 1; i < ranking.length; i++) expect(ranking[i - 1].score).toBeGreaterThanOrEqual(ranking[i].score);
    expect(out.structured?.kind).toBe("ranking");
  });

  it("finds Santa Ana more congested than LAX on the real 2025 delay data", () => {
    // Real BTS 2025: SNA 15.2 min average delay, 19.2% delayed, 1.1% cancelled;
    // LAX 13.8 min, 18.1%, 0.7%. The old curated file had this the other way round.
    const out = compareAirports(["LAX", "SNA"], "congestion");
    const comp = out.result.comparison as Array<{ iata: string; score: number }>;
    const lax = comp.find((c) => c.iata === "LAX")!;
    const sna = comp.find((c) => c.iata === "SNA")!;
    expect(sna.score).toBeGreaterThan(lax.score);
  });

  it("reports Anchorage long-haul share", () => {
    const out = longHaulBreakdown("ANC");
    const mix = out.result.haul_mix_pct as { long: number };
    expect(mix.long).toBeGreaterThan(0);
    expect(out.structured?.kind).toBe("breakdown");
  });

  it("estimates SFO unmet demand with drivers", () => {
    const out = unmetDemand("SFO");
    expect(typeof out.result.unmet_demand_score).toBe("number");
    expect(out.result.drivers).toBeTruthy();
    expect(out.uncertainty).toBeTruthy(); // must always carry a caveat
  });

  it("handles unknown airports gracefully", () => {
    const out = longHaulBreakdown("ZZZ");
    expect(out.result.error).toBeTruthy();
  });

  it("states the data year, metro and international share in a profile", () => {
    const out = airportProfile("JFK");
    expect(out.result.data_year).toBe(2025);
    expect(out.result.metro_area).toBe("New York-Newark-Jersey City, NY-NJ");
    const metrics = out.result.metrics as { international_passenger_share: number };
    expect(metrics.international_passenger_share).toBeGreaterThan(0.4);
  });
});

describe("insufficient data in tools", () => {
  // No bundled airport has a suppressed input in 2025, so suppress one through the data module.
  const withSuppressedDelay = <T>(iata: string, run: () => T): T => {
    const airport = data.getAirport(iata)!;
    const saved = airport.avg_dep_delay_min;
    airport.avg_dep_delay_min = null;
    try {
      return run();
    } finally {
      airport.avg_dep_delay_min = saved;
    }
  };

  it("leaves an unscorable airport out of a ranking and names it", () => {
    const out = withSuppressedDelay("BTV", () => rankAirports("New England", "congestion", 10));
    const ranked = (out.result.ranking as Array<{ iata: string }>).map((r) => r.iata);
    expect(ranked).not.toContain("BTV");
    expect(out.result.insufficient_data).toEqual([{ iata: "BTV", missing: ["avg_dep_delay_min"] }]);
    expect(out.structured?.caption).toContain("1 not scored (insufficient data)");
  });

  it("shows 'insufficient data' instead of a score in a comparison", () => {
    const out = withSuppressedDelay("SNA", () => compareAirports(["LAX", "SNA"], "congestion"));
    const sna = (out.result.comparison as Array<{ iata: string; score: number | null; insufficient_data?: string }>).find(
      (c) => c.iata === "SNA",
    )!;
    expect(sna.score).toBeNull();
    expect(sna.insufficient_data).toMatch(/^Insufficient data/);
    expect(out.structured?.rows.find((r) => String(r[0]).startsWith("SNA"))?.[1]).toBe("insufficient data");
    expect(out.structured?.explain?.rows.map((r) => r.airport)).toEqual(["LAX — Los Angeles"]);
  });

  it("refuses a single-airport unmet-demand score rather than defaulting", () => {
    const out = withSuppressedDelay("SFO", () => unmetDemand("SFO"));
    expect(out.result.insufficient_data).toBeTruthy();
    expect(out.result.unmet_demand_score).toBeUndefined();
    expect(out.structured).toBeUndefined();
  });
});

describe("scope handling against model behaviour", () => {
  const rankedCodes = (out: ReturnType<typeof rankAirports>): string[] =>
    (out.result.ranking as Array<{ iata: string }>).map((r) => r.iata);

  it("prefers the user's words over a narrowed scope the model chose (northeast -> new england)", () => {
    const out = rankAirports("new england", "unmet_demand", 20, "northeast");
    expect(rankedCodes(out)).toEqual(expect.arrayContaining(["BOS", "JFK", "LGA", "EWR"]));
    expect(out.result.scope_label).toBe("Northeast");
    expect(out.result.scope_resolved_as).toBe("census_region");
    expect((out.result.scope_notes as string[]).join(" ")).toContain("do not describe it as 'new england'");
    expect(out.structured?.caption).toContain("Scope: Northeast · Census region");
  });

  it("does not add a mismatch note when scope and words agree", () => {
    const out = rankAirports("northeast", "expansion", 5, "Northeast");
    expect((out.result.scope_notes as string[]).join(" ")).not.toContain("resolved from the user's words");
  });

  it("reads 'Northeast US including New York and New Jersey' as the Northeast and flags it in the caption", () => {
    const out = rankAirports("NJ", "unmet_demand", 20, "Northeast US including New York and New Jersey");
    expect(rankedCodes(out)).toEqual(expect.arrayContaining(["BOS", "JFK", "EWR"]));
    expect(out.structured?.caption).toContain('read from "Northeast US including New York and New Jersey"');
    expect(out.structured?.caption?.startsWith("Scope: Northeast ·")).toBe(true);
  });

  it("falls back to the passed scope when the user's words are not understood", () => {
    const out = rankAirports("California", "expansion", 3, "gibberish zzz");
    expect(out.result.scope_label).toBe("California");
  });

  it("compares every airport in a named area without asking for codes", () => {
    const out = compareAirports([], "congestion", "Bay Area", "Bay Area");
    const codes = (out.result.comparison as Array<{ iata: string }>).map((c) => c.iata).sort();
    expect(codes).toEqual(["OAK", "SFO", "SJC"]);
    expect(out.result.scope_note).toContain("Compared all 3");
  });

  it("caps a scope comparison at the busiest airports and says so", () => {
    const out = compareAirports([], "congestion", "all");
    expect((out.result.comparison as unknown[]).length).toBe(8);
    expect(out.result.scope_note).toContain("busiest");
  });

  it("reports an unusable comparison scope with coverage instead of a table", () => {
    const out = compareAirports([], "congestion", "Nowhere");
    expect(out.structured).toBeUndefined();
    expect(out.result.coverage).toBeTruthy();
  });

  it("tells the model when fewer airports matched than asked for", () => {
    const out = rankAirports("Washington state", "expansion", 3, "WA");
    expect(out.result.airports_matched).toBe(2); // SEA and GEG
    expect(out.result.airports_returned).toBe(2);
    expect(out.result.requested_top_n).toBe(3);
    expect(out.result.count_note).toContain("Only 2 airports");
    expect(out.result.dataset_states).toContain("MA");
  });

  it("omits the shortfall note when enough airports matched", () => {
    expect(rankAirports("all", "expansion", 3).result.count_note).toBeUndefined();
  });

  it("instructs the model to pass place words verbatim and offers scope comparison", async () => {
    const { TOOL_SCHEMAS } = await import("./tools");
    for (const name of ["rank_airports", "compare_airports"]) {
      const schema = TOOL_SCHEMAS.find((t) => t.name === name)!;
      const props = schema.input_schema.properties as Record<string, { description: string }>;
      expect(props.scope.description).toContain("VERBATIM");
      expect(props.user_words).toBeTruthy();
    }
    const compare = TOOL_SCHEMAS.find((t) => t.name === "compare_airports")!;
    expect(compare.input_schema.required).toEqual([]);
  });
});
