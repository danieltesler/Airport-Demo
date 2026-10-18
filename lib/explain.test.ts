import { describe, expect, it } from "vitest";
import { airportsInScope } from "./data";
import { explainScores } from "./explain";
import { CONGESTION_WEIGHTS, METRIC_WEIGHTS, loadFactorInfluence, type MetricKey } from "./scoring";
import { comparisonCaption, rankingCaption } from "./i18n";
import { compareAirports, rankAirports } from "./tools";

const METRICS: MetricKey[] = ["congestion", "unmet_demand", "expansion"];
const label = (a: { iata: string }) => a.iata;

describe("explainScores", () => {
  it.each(METRICS)("%s: weights come from scoring.ts and sum to 1", (metric) => {
    const explain = explainScores(airportsInScope("all").slice(0, 3), metric, label);
    const weights = Object.values(METRIC_WEIGHTS[metric]);
    expect(explain.components.map((c) => c.weight)).toEqual(weights);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it.each(METRICS)("%s: per-component points add up to the airport score", (metric) => {
    const explain = explainScores(airportsInScope("all"), metric, label);
    for (const row of explain.rows) {
      const total = row.parts.reduce((sum, p) => sum + p.points, 0);
      // Each of up to 4 points is rounded to 1 dp, so allow that much drift.
      expect(Math.abs(total - row.score)).toBeLessThanOrEqual(0.25);
    }
  });

  it("discloses the load-factor double count where congestion is a component", () => {
    const [expansion, unmet, congestion] = (["expansion", "unmet_demand", "congestion"] as const).map(
      (m) => explainScores(airportsInScope("all").slice(0, 1), m, label),
    );
    expect(expansion.notes[0]).toMatch(/counted twice/);
    expect(unmet.notes[0]).toMatch(/counted twice/);
    expect(congestion.notes).toEqual([]);
  });

  it("computes load-factor influence from the weights, not constants", () => {
    const expansion = loadFactorInfluence("expansion");
    expect(expansion.direct).toBe(METRIC_WEIGHTS.expansion.load_pressure);
    expect(expansion.viaCongestion).toBeCloseTo(
      METRIC_WEIGHTS.expansion.congestion * CONGESTION_WEIGHTS.load_pressure,
      10,
    );
    expect(loadFactorInfluence("congestion").viaCongestion).toBe(0);
  });
});

describe("table captions and model context", () => {
  it("uses singular wording for one airport", () => {
    expect(comparisonCaption(1, "Congestion score")).toBe("Comparing 1 airport · congestion score");
    expect(rankingCaption({ scope: "all", matched: 1, shown: 1, scoreLabel: "X" })).toContain("1 airport matched");
  });

  it("trims whitespace around the scope in the caption", () => {
    expect(rankingCaption({ scope: " all ", matched: 5, shown: 3, scoreLabel: "X" })).toContain("all airports");
    expect(rankingCaption({ scope: "  new_england ", matched: 5, shown: 3, scoreLabel: "X" })).toContain(
      "Scope: new england ·",
    );
  });

  it("compares a duplicated airport once", () => {
    const out = compareAirports(["LAX", "lax", "SNA"], "congestion");
    expect(out.structured?.rows).toHaveLength(2);
    expect(out.structured?.explain?.rows.map((r) => r.airport)).toEqual(["LAX — Los Angeles", "SNA — Santa Ana"]);
  });

  it("echoes resolved scope and matched airport count", () => {
    const out = rankAirports("new_england", "expansion", 3);
    const matched = airportsInScope("new_england").length;
    expect(out.structured?.caption).toContain("new england");
    expect(out.structured?.caption).toContain(`${matched} airports matched`);
    expect(out.structured?.caption).toContain("top 3");
  });

  it("describes the default scope as all airports", () => {
    const out = rankAirports(undefined, "congestion", 5);
    expect(out.structured?.caption).toContain("all airports");
  });

  it("keeps caption and explanation out of the model-visible result", () => {
    for (const out of [rankAirports("CA", "expansion", 3), compareAirports(["LAX", "SNA"], "congestion")]) {
      const modelText = JSON.stringify(out.result);
      expect(modelText).not.toContain(out.structured!.caption!);
      expect(modelText).not.toContain("counted twice");
      expect(out.structured?.explain?.rows.length).toBeGreaterThan(0);
    }
  });
});
