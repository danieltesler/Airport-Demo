import { describe, expect, it } from "vitest";
import type { Airport } from "./data";
import * as data from "./data";
import {
  ANCHORS,
  CONGESTION_WEIGHTS,
  EXPANSION_WEIGHTS,
  UNMET_DEMAND_WEIGHTS,
  clamp,
  congestionScore,
  expansionScore,
  growthVsCapacity,
  haulBreakdown,
  isScored,
  loadFactorPressure,
  unmetDemandScore,
  type ScoreOutcome,
  type ScoreResult,
} from "./scoring";

/** Build an airport fixture with mid-range real-world values, overridable per test. */
function makeAirport(overrides: Partial<Airport> = {}): Airport {
  return {
    iata: "TST",
    icao: "KTST",
    name: "Test",
    city: "Test",
    state: "CA",
    lat: 0,
    lon: 0,
    runways: 2,
    annual_passengers: 10_000_000,
    annual_departures: 60_000,
    international_passenger_share: 0.05,
    pax_growth_yoy: 0.01,
    load_factor: 0.78,
    avg_dep_delay_min: 15,
    delayed_share: 0.2,
    cancel_rate: 0.012,
    haul_mix: { short: 0.6, medium: 0.3, long: 0.1 },
    ...overrides,
  };
}

/** The scored result, failing the test if the score was reported as insufficient data. */
function scored(outcome: ScoreOutcome): ScoreResult {
  if (!isScored(outcome)) throw new Error(`expected a score, got: ${outcome.reason}`);
  return outcome;
}

describe("primitives", () => {
  it("clamps to [low, high]", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(0.5)).toBe(0.5);
  });

  it("scales load factor between its anchors", () => {
    const { low, high } = ANCHORS.load_factor;
    expect(loadFactorPressure(low)).toBe(0);
    expect(loadFactorPressure(high)).toBe(1);
    expect(loadFactorPressure((low + high) / 2)).toBeCloseTo(0.5);
    expect(loadFactorPressure(high + 0.1)).toBe(1); // clamped
  });
});

describe("congestion", () => {
  it("stays within 0-100", () => {
    const { score, components } = scored(congestionScore(makeAirport()));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Object.keys(components).sort()).toEqual(Object.keys(CONGESTION_WEIGHTS).sort());
  });

  it("rates a busy airport as more congested than a calm one", () => {
    const calm = makeAirport({ avg_dep_delay_min: 10, delayed_share: 0.14, cancel_rate: 0.005 });
    const busy = makeAirport({ avg_dep_delay_min: 21, delayed_share: 0.27, cancel_rate: 0.03 });
    expect(scored(congestionScore(busy)).score).toBeGreaterThan(scored(congestionScore(calm)).score);
  });

  it("ignores load factor", () => {
    const low = scored(congestionScore(makeAirport({ load_factor: 0.7 }))).score;
    const high = scored(congestionScore(makeAirport({ load_factor: 0.9 }))).score;
    expect(low).toBe(high);
  });
});

describe("growth can be negative", () => {
  const growth = (pax_growth_yoy: number) => makeAirport({ pax_growth_yoy });

  it("scores a declining airport below a flat one, and a flat one below a growing one", () => {
    for (const scorer of [expansionScore, unmetDemandScore]) {
      const declining = scored(scorer(growth(-0.05))).score;
      const flat = scored(scorer(growth(0))).score;
      const growing = scored(scorer(growth(0.05))).score;
      expect(declining).toBeLessThan(flat);
      expect(flat).toBeLessThan(growing);
    }
    expect(growthVsCapacity(growth(-0.05))).toBeLessThan(growthVsCapacity(growth(0)));
  });

  it("separates two declining airports instead of clamping both to zero", () => {
    const mild = scored(expansionScore(growth(-0.01))).components.demand_growth;
    const steep = scored(expansionScore(growth(-0.07))).components.demand_growth;
    expect(mild).toBeGreaterThan(steep);
    expect(steep).toBeGreaterThan(0);
  });
});

describe("weights", () => {
  it("each composite's weights sum to 1", () => {
    const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum(CONGESTION_WEIGHTS)).toBeCloseTo(1);
    expect(sum(EXPANSION_WEIGHTS)).toBeCloseTo(1);
    expect(sum(UNMET_DEMAND_WEIGHTS)).toBeCloseTo(1);
  });
});

describe("haul mix", () => {
  it("converts fractions to percentages", () => {
    const mix = haulBreakdown(makeAirport({ haul_mix: { short: 0.5, medium: 0.3, long: 0.2 } }));
    expect(mix).toEqual({ short: 50, medium: 30, long: 20 });
  });

  it("returns null when the source suppressed the haul mix", () => {
    expect(haulBreakdown(makeAirport({ haul_mix: null }))).toBeNull();
  });
});

describe("expansion & unmet demand", () => {
  it("prefers a growing, constrained airport for expansion", () => {
    const weak = makeAirport({
      pax_growth_yoy: -0.04,
      load_factor: 0.74,
      avg_dep_delay_min: 11,
      delayed_share: 0.15,
      cancel_rate: 0.006,
      annual_passengers: 2_000_000,
    });
    const strong = makeAirport({
      pax_growth_yoy: 0.06,
      load_factor: 0.82,
      avg_dep_delay_min: 20,
      delayed_share: 0.25,
      cancel_rate: 0.02,
      annual_passengers: 40_000_000,
    });
    expect(scored(expansionScore(strong)).score).toBeGreaterThan(scored(expansionScore(weak)).score);
  });

  it("keeps unmet-demand components bounded and always carries a caveat", () => {
    const result = scored(unmetDemandScore(makeAirport()));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(result.uncertainty).toBeTruthy();
  });
});

describe("insufficient data is reported, never defaulted", () => {
  it("does not score congestion when a delay rate is suppressed, and names the missing input", () => {
    const outcome = congestionScore(makeAirport({ avg_dep_delay_min: null }));
    expect(outcome.score).toBeNull();
    expect(isScored(outcome)).toBe(false);
    if (!isScored(outcome)) {
      expect(outcome.missing).toEqual(["avg_dep_delay_min"]);
      expect(outcome.reason).toMatch(/^Insufficient data/);
    }
  });

  it("carries a missing delay rate through to the composites", () => {
    const airport = makeAirport({ delayed_share: null });
    expect(unmetDemandScore(airport).score).toBeNull();
    expect(expansionScore(airport).score).toBeNull();
  });

  it("scores congestion but not expansion when only growth is missing", () => {
    const airport = makeAirport({ pax_growth_yoy: null });
    expect(congestionScore(airport).score).not.toBeNull();
    const outcome = expansionScore(airport);
    expect(outcome.score).toBeNull();
    if (!isScored(outcome)) expect(outcome.missing).toEqual(["pax_growth_yoy"]);
  });
});

describe("data layer", () => {
  it("loads the dataset with key airports present", () => {
    const codes = new Set(data.knownIatas());
    for (const expected of ["SFO", "LAX", "SNA", "ANC", "BOS", "BOI", "BTV", "MHT"]) {
      expect(codes.has(expected)).toBe(true);
    }
  });

  it("scores every bundled airport (no input is suppressed in the 2025 data)", () => {
    for (const airport of data.allAirports()) {
      expect(isScored(congestionScore(airport))).toBe(true);
      expect(isScored(unmetDemandScore(airport))).toBe(true);
      expect(isScored(expansionScore(airport))).toBe(true);
    }
  });

  it("scopes New England without leaking other states", () => {
    const ne = data.airportsInScope("new_england");
    const states = new Set(ne.map((a) => a.state));
    for (const s of states) expect(["ME", "NH", "VT", "MA", "RI", "CT"]).toContain(s);
    expect(ne.some((a) => a.iata === "BOS")).toBe(true);
    expect(ne.some((a) => a.iata === "SFO")).toBe(false);
  });

  it("looks up airports case-insensitively", () => {
    expect(data.getAirport("sfo")?.iata).toBe("SFO");
    expect(data.getAirport("SFO")?.iata).toBe("SFO");
    expect(data.getAirport("ZZZ")).toBeUndefined();
  });

  it("resolves state names and metro areas, and rejects unknown scopes", () => {
    expect(data.airportsInScope("California").some((a) => a.iata === "LAX")).toBe(true);
    expect(data.airportsInScope("CA").some((a) => a.iata === "LAX")).toBe(true);
    // The LA alias is a 60-mile radius; with the full dataset that takes in Burbank, Long Beach and Ontario too.
    expect(data.airportsInScope("LA").map((a) => a.iata).sort()).toEqual(["BUR", "LAX", "LGB", "ONT", "SNA"]);
    expect(data.airportsInScope("Bay Area").map((a) => a.iata).sort()).toEqual(["OAK", "SFO", "SJC"]);
    expect(data.airportsInScope("Nowhere")).toEqual([]);
  });

  it("carries real provenance for every scored input", () => {
    const fields = data.fieldProvenance();
    for (const field of ["annual_passengers", "pax_growth_yoy", "load_factor", "avg_dep_delay_min", "delayed_share", "cancel_rate", "haul_mix"]) {
      expect(fields[field]?.formula).toBeTruthy();
      expect(fields[field]?.sources.length).toBeGreaterThan(0);
    }
    expect(data.dataVintage()).not.toMatch(/estimat/i);
    expect(data.dataYear()).toBe(2025);
  });
});
