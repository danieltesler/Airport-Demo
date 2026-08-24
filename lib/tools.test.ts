import { describe, expect, it } from "vitest";
import { compareAirports, longHaulBreakdown, rankAirports, unmetDemand } from "./tools";

/**
 * End-to-end checks for the four exam questions, exercised through the tools
 * (the LLM layer is not involved — these assert the deterministic answers).
 */
describe("exam questions via tools", () => {
  it("ranks New England expansion candidates with Boston on top", () => {
    const out = rankAirports("new_england", "expansion", 3);
    const ranking = out.result.ranking as Array<{ iata: string }>;
    expect(ranking[0].iata).toBe("BOS");
    expect(out.structured?.kind).toBe("ranking");
  });

  it("finds LAX more congested than Santa Ana", () => {
    const out = compareAirports(["LAX", "SNA"], "congestion");
    const comp = out.result.comparison as Array<{ iata: string; score: number }>;
    const lax = comp.find((c) => c.iata === "LAX")!;
    const sna = comp.find((c) => c.iata === "SNA")!;
    expect(lax.score).toBeGreaterThan(sna.score);
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
});
