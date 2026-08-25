import { describe, expect, it } from "vitest";
import type { Airport } from "./data";
import * as data from "./data";
import {
  CONGESTION_WEIGHTS,
  EXPANSION_WEIGHTS,
  UNMET_DEMAND_WEIGHTS,
  clamp,
  congestionScore,
  expansionScore,
  haulBreakdown,
  loadFactorPressure,
  normalize,
  unmetDemandScore,
} from "./scoring";

/** Build an airport fixture with sensible defaults, overridable per test. */
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
    pax_growth_yoy: 0.05,
    load_factor: 0.8,
    avg_dep_delay_min: 12,
    delayed_share: 0.15,
    cancel_rate: 0.02,
    annual_departures: 60_000,
    haul_mix: { short: 0.6, medium: 0.3, long: 0.1 },
    ...overrides,
  };
}

describe("primitives", () => {
  it("clamps to [low, high]", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(0.5)).toBe(0.5);
  });

  it("normalizes against a full scale", () => {
    expect(normalize(30, 30)).toBe(1);
    expect(normalize(15, 30)).toBe(0.5);
    expect(normalize(60, 30)).toBe(1); // clamped
  });

  it("computes load-factor pressure at floor and ceiling", () => {
    expect(loadFactorPressure(0.7)).toBe(0);
    expect(loadFactorPressure(0.9)).toBe(1);
    expect(loadFactorPressure(0.8)).toBeCloseTo(0.5);
  });
});

describe("congestion", () => {
  it("stays within 0-100", () => {
    const { score, components } = congestionScore(makeAirport());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Object.keys(components).sort()).toEqual(Object.keys(CONGESTION_WEIGHTS).sort());
  });

  it("rates a busy airport as more congested than a calm one", () => {
    const calm = makeAirport({ avg_dep_delay_min: 8, delayed_share: 0.1, cancel_rate: 0.01, load_factor: 0.75 });
    const busy = makeAirport({ avg_dep_delay_min: 25, delayed_share: 0.3, cancel_rate: 0.04, load_factor: 0.88 });
    expect(congestionScore(busy).score).toBeGreaterThan(congestionScore(calm).score);
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
});

describe("expansion & unmet demand", () => {
  it("prefers a growing, constrained airport for expansion", () => {
    const weak = makeAirport({
      pax_growth_yoy: 0.01,
      load_factor: 0.72,
      avg_dep_delay_min: 8,
      delayed_share: 0.1,
      cancel_rate: 0.01,
      annual_passengers: 2_000_000,
    });
    const strong = makeAirport({
      pax_growth_yoy: 0.1,
      load_factor: 0.88,
      avg_dep_delay_min: 20,
      delayed_share: 0.28,
      cancel_rate: 0.03,
      annual_passengers: 50_000_000,
    });
    expect(expansionScore(strong).score).toBeGreaterThan(expansionScore(weak).score);
  });

  it("keeps unmet-demand components bounded and always carries a caveat", () => {
    const result = unmetDemandScore(makeAirport());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(result.uncertainty).toBeTruthy();
  });
});

describe("data layer", () => {
  it("loads the dataset with key airports present", () => {
    const codes = new Set(data.knownIatas());
    for (const expected of ["SFO", "LAX", "SNA", "ANC", "BOS"]) {
      expect(codes.has(expected)).toBe(true);
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
    expect(data.airportsInScope("LA").map((a) => a.iata).sort()).toEqual(["LAX", "SNA"]);
    expect(data.airportsInScope("Bay Area").map((a) => a.iata).sort()).toEqual(["OAK", "SFO", "SJC"]);
    expect(data.airportsInScope("Nowhere")).toEqual([]);
  });
});
