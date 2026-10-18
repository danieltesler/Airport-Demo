import { describe, expect, it } from "vitest";
import { airportsInScope } from "./data";
import { explainScores } from "./explain";
import { CONGESTION_WEIGHTS, METRIC_WEIGHTS, congestionScore, type MetricKey } from "./scoring";
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
      // The points are rounded together (largest remainder), so they add up to the displayed score exactly.
      expect(Math.round(total * 10) / 10).toBe(row.score);
    }
  });

  it("counts load factor once: congestion ignores it, so effective weight equals the documented one", () => {
    const [low, high] = [0.7, 0.9].map((load_factor) => ({ ...airportsInScope("all")[0], load_factor }));
    expect(congestionScore(low).score).toBe(congestionScore(high).score);
    expect(CONGESTION_WEIGHTS.load_pressure).toBeUndefined();

    for (const metric of ["unmet_demand", "expansion"] as const) {
      const weights = METRIC_WEIGHTS[metric];
      const effective = weights.load_pressure + weights.congestion * (CONGESTION_WEIGHTS.load_pressure ?? 0);
      expect(effective).toBe(weights.load_pressure);
    }
  });
});

describe("table captions and model context", () => {
  it("uses singular wording for one airport", () => {
    expect(comparisonCaption(1, "Congestion score")).toBe("Comparing 1 airport · congestion score");
    expect(rankingCaption({ label: "all airports", resolvedAs: "all", matched: 1, shown: 1, scoreLabel: "X" })).toContain(
      "1 airport matched",
    );
  });

  it("states how the scope was resolved, label first", () => {
    expect(
      rankingCaption({ label: "New England", resolvedAs: "census_division", matched: 6, shown: 3, scoreLabel: "Expansion score" }),
    ).toBe("Scope: New England · Census division · 6 airports matched · top 3 by expansion score");
    expect(rankingCaption({ label: "all airports", resolvedAs: "all", matched: 28, shown: 5, scoreLabel: "X" })).toBe(
      "Scope: all airports · 28 airports matched · top 5 by x",
    );
  });

  it("tolerates whitespace and case in the typed scope", () => {
    const out = rankAirports("  new_england ", "expansion", 3);
    expect(out.structured?.caption).toContain("Scope: New England · Census division ·");
  });

  it("compares a duplicated airport once", () => {
    const out = compareAirports(["LAX", "lax", "SNA"], "congestion");
    expect(out.structured?.rows).toHaveLength(2);
    expect(out.structured?.explain?.rows.map((r) => r.airport)).toEqual(["SNA — Santa Ana", "LAX — Los Angeles"]); // highest congestion score first
  });

  it("echoes resolved scope and matched airport count", () => {
    const out = rankAirports("new_england", "expansion", 3);
    const matched = airportsInScope("new_england").length;
    expect(out.structured?.caption).toContain("Scope: New England · Census division");
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
      expect(out.structured?.explain?.rows.length).toBeGreaterThan(0);
    }
  });
});
