/**
 * compare_airports must compare exactly the airports the user named, whatever mix of iatas,
 * scope and user_words the model sends, and expand only a real area.
 */

import { describe, expect, it } from "vitest";
import { clearLiveCaches } from "./live/common";
import { metroPopulation } from "./live/census";
import { compareAirports } from "./tools";

const codesOf = (out: ReturnType<typeof compareAirports>): string[] =>
  (out.result.comparison as { iata: string }[]).map((c) => c.iata).sort();

describe("compare_airports reads named airports exactly", () => {
  // The model usually omits iatas and passes the user's words in scope and/or user_words.
  const phrasings: [string, string[]][] = [
    ["LAX and SNA", ["LAX", "SNA"]],
    ["LAX vs SNA", ["LAX", "SNA"]],
    ["compare LAX and SNA congestion", ["LAX", "SNA"]],
    ["compare Los Angeles and Santa Ana", ["LAX", "SNA"]],
    ["JFK vs EWR", ["EWR", "JFK"]],
    ["compare JFK, LGA and EWR", ["EWR", "JFK", "LGA"]],
    ["ATL versus ORD", ["ATL", "ORD"]],
    ["lax & sna", ["LAX", "SNA"]],
  ];
  for (const [words, expected] of phrasings) {
    it(`'${words}' compares ${expected.join(", ")} only`, () => {
      for (const out of [
        compareAirports([], "congestion", words, words), // scope and words
        compareAirports([], "congestion", undefined, words), // user_words only
        compareAirports([], "congestion", words), // scope only
      ]) {
        expect(codesOf(out)).toEqual(expected);
        expect(out.structured?.rows).toHaveLength(expected.length);
        expect(out.structured?.caption).toBe(
          `Comparing ${expected.length} airports: ${expected.join(", ")} · congestion score`,
        );
        expect(out.result.scope_note).toContain("exactly the airports named");
      }
    });
  }

  it("still compares an area when the words name one (Bay Area), labelled in the caption", () => {
    const out = compareAirports([], "congestion", "Bay Area", "Bay Area");
    expect(codesOf(out)).toEqual(["OAK", "SFO", "SJC"]);
    expect(out.structured?.caption).toBe("Comparing 3 airports in San Francisco Bay Area (metro area) · congestion score");
  });

  it("labels a capped area comparison with how many airports it was cut from", () => {
    const out = compareAirports([], "congestion", "California", "California");
    expect(out.structured?.rows).toHaveLength(8);
    expect(out.structured?.caption).toMatch(/^Comparing 8 airports in California \(state\), the busiest of \d+ · congestion score$/);
  });

  it("says ambiguous when a named city matches several airports, never silently expanding", () => {
    const out = compareAirports([], "congestion", undefined, "New York and Chicago");
    expect(out.result).toMatchObject({ status: "ambiguous" });
    expect(String(out.result.error)).toMatch(/matches more than one airport/);
    expect((out.result.options as { scope: string }[]).map((o) => o.scope)).toEqual(expect.arrayContaining(["JFK", "LGA"]));
    expect(out.structured).toBeUndefined();
  });

  it("uses explicit iatas as before and says so in the caption", () => {
    const out = compareAirports(["lax", "SNA"], "congestion");
    expect(out.structured?.caption).toBe("Comparing 2 airports: LAX, SNA · congestion score");
  });

  it("an unknown airport code in the words is reported, not ignored or widened", () => {
    const out = compareAirports([], "congestion", undefined, "LAX and ZZZ");
    expect(out.structured).toBeUndefined();
    expect(out.result.error).toBeTruthy();
  });

  it("orders the table by score, highest first, with insufficient data last", () => {
    const out = compareAirports(["LAX", "SNA", "JFK"], "congestion");
    const scores = (out.result.comparison as { score: number }[]).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(out.structured?.rows.map((r) => r[1])).toEqual(scores);
  });
});

describe("metro population without a Census key", () => {
  it("says not configured, gives no population from the dataset, and flags do_not_estimate", async () => {
    clearLiveCaches();
    const saved = process.env.CENSUS_API_KEY;
    delete process.env.CENSUS_API_KEY;
    try {
      const out = await metroPopulation(
        { iata: "SEA" },
        { resolveAirport: () => ({ iata: "SEA", icao: "KSEA", name: "Seattle-Tacoma", city: "Seattle", state: "WA", lat: 47.45, lon: -122.31 }) },
      );
      expect(out.result).toMatchObject({ available: false, do_not_estimate: true });
      expect(String(out.result.message)).toMatch(/not configured/);
      expect(String(out.result.fallback)).toMatch(/No population figure exists in the bundled dataset/);
      expect(String(out.result.fallback)).toMatch(/do not give a number/);
      expect(String(out.result.fallback)).not.toMatch(/offer it/);
      expect(out.structured).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CENSUS_API_KEY = saved;
    }
  });

  it("the airport profile offers nothing population-like to quote", async () => {
    const { airportProfile } = await import("./tools");
    const text = JSON.stringify(airportProfile("SEA").result).toLowerCase();
    expect(text).not.toMatch(/population|residents|inhabitants/);
  });
});
