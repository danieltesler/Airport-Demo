import { describe, expect, it } from "vitest";
import { allAirports } from "./data";
import { deriveAnchor, percentile, roundSignificant, scaleToAnchor } from "./anchors";
import { ANCHORS, ANCHOR_INPUTS, type AnchorKey } from "./scoring";

describe("the anchor rule", () => {
  it("interpolates percentiles linearly (PERCENTILE.INC)", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
    expect(() => percentile([], 0.5)).toThrow();
  });

  it("rounds to two significant figures without float noise", () => {
    expect(roundSignificant(0.07419)).toBe(0.074);
    expect(roundSignificant(25_848_627)).toBe(26_000_000);
    expect(roundSignificant(10.9)).toBe(11);
    expect(roundSignificant(0.005175)).toBe(0.0052);
  });

  it("rounds anchors outward: low down, high up", () => {
    expect(roundSignificant(-0.08328, 2, "down")).toBe(-0.084);
    expect(roundSignificant(0.8246, 2, "up")).toBe(0.83);
    expect(roundSignificant(4852, 2, "down")).toBe(4800);
    expect(roundSignificant(68_640, 2, "up")).toBe(69_000);
    expect(deriveAnchor([0.7336, 0.8246])).toEqual({ low: 0.73, high: 0.83 });
  });

  it("scales two-sided and clamps", () => {
    const anchor = { low: -0.1, high: 0.1 };
    expect(scaleToAnchor(-0.2, anchor)).toBe(0);
    expect(scaleToAnchor(0, anchor)).toBeCloseTo(0.5);
    expect(scaleToAnchor(0.2, anchor)).toBe(1);
  });
});

describe("anchors in lib/scoring.ts", () => {
  /**
   * The anchors are constants so a score does not shift with the scope asked about. This
   * test is what keeps them honest: they must equal the rule applied to the bundled data.
   * If a data refresh moves them, update ANCHORS to the derived values printed here
   * (npm run anchors) -- never to values chosen by hand.
   */
  it.each(Object.keys(ANCHORS) as AnchorKey[])("%s equals the 5th/95th percentile rule on data/airports.json", (key) => {
    const values = allAirports()
      .map(ANCHOR_INPUTS[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    expect(values.length).toBeGreaterThan(50);
    expect(ANCHORS[key]).toEqual(deriveAnchor(values));
  });

  it("leaves only the tails clamped, so the top of a ranking keeps its resolution", () => {
    for (const key of Object.keys(ANCHORS) as AnchorKey[]) {
      const values = allAirports().map(ANCHOR_INPUTS[key]).filter((v): v is number => v !== null);
      const atCeiling = values.filter((v) => scaleToAnchor(v, ANCHORS[key]) === 1).length;
      const atFloor = values.filter((v) => scaleToAnchor(v, ANCHORS[key]) === 0).length;
      // About 5% per tail by construction; ties at the cut-off can add an airport or two.
      expect(atCeiling / values.length).toBeLessThanOrEqual(0.07);
      expect(atFloor / values.length).toBeLessThanOrEqual(0.07);
    }
  });
});
