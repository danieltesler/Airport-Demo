import { describe, expect, it } from "vitest";
import * as data from "./data";
import { roundSignificant } from "./anchors";
import { explainScores } from "./explain";
import { largestRemainder, roundTo } from "./rounding";
import { carrierShare } from "./routeTools";
import { METRIC_WEIGHTS, type MetricKey } from "./scoring";

describe("roundTo", () => {
  it("rounds exact halves up despite binary noise", () => {
    expect(roundTo(0.285, 2)).toBe(0.29); // 0.285 * 100 = 28.499999999999996
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(79.85, 1)).toBe(79.9);
    expect(roundTo(-0.25, 1)).toBe(-0.2); // half rounds toward +infinity, as Math.round does
    expect(roundTo(64.65, 1)).toBe(64.7);
  });
});

describe("largestRemainder", () => {
  it("adds up exactly to the total and never goes negative", () => {
    const parts = [33.333333, 33.333333, 33.333334];
    const out = largestRemainder(parts, 100, 1);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
    expect(out.every((v) => v >= 0)).toBe(true);
  });

  it("gives the leftover to the largest fractions, ties to the earlier value", () => {
    expect(largestRemainder([1.5, 1.5, 1], 4, 0)).toEqual([2, 1, 1]);
    expect(largestRemainder([0.25, 0.25, 0.5], 1, 1)).toEqual([0.3, 0.2, 0.5]);
  });
});

describe("carrier shares add up to exactly 100.0 for every airport", () => {
  const sum = (values: number[]): number => Math.round(values.reduce((a, b) => a + b, 0) * 10) / 10;

  it("sweeps all 102 airports at several top_n values, Other included, none negative", async () => {
    let checked = 0;
    for (const airport of data.allAirports()) {
      for (const top_n of [1, 3, 5, 8, 15]) {
        const out = await carrierShare({ origin: airport.iata, top_n });
        const carriers = out.result.carriers as { seat_share_pct: number; departure_share_pct: number }[];
        const other = out.result.other as { seat_share_pct: number; departure_share_pct: number } | null;
        const seats = [...carriers.map((c) => c.seat_share_pct), ...(other ? [other.seat_share_pct] : [])];
        const departures = [...carriers.map((c) => c.departure_share_pct), ...(other ? [other.departure_share_pct] : [])];
        expect(sum(seats), `${airport.iata} top ${top_n} seats`).toBe(100);
        expect(sum(departures), `${airport.iata} top ${top_n} departures`).toBe(100);
        expect(Math.min(...seats, ...departures), `${airport.iata} top ${top_n}`).toBeGreaterThanOrEqual(0);
        checked += 1;
      }
    }
    expect(checked).toBe(data.allAirports().length * 5);
  });

  it("no longer shows the negative Other the review found (DAL top 3, ONT top 15, PBI)", async () => {
    for (const [origin, top_n] of [["DAL", 3], ["ONT", 15], ["PBI", 5], ["PBI", 8]] as const) {
      const other = (await carrierShare({ origin, top_n })).result.other as { seat_share_pct: number; departure_share_pct: number } | null;
      if (other) expect(Math.min(other.seat_share_pct, other.departure_share_pct)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("'How was this scored?' parts add up to the displayed score", () => {
  it("holds for every airport and every metric", () => {
    const airports = data.allAirports();
    for (const metric of Object.keys(METRIC_WEIGHTS) as MetricKey[]) {
      const explanation = explainScores(airports, metric, (a) => a.iata);
      expect(explanation.rows.length).toBeGreaterThan(90);
      for (const row of explanation.rows) {
        const total = Math.round(row.parts.reduce((sum, part) => sum + part.points, 0) * 10) / 10;
        expect(total, `${row.airport} ${metric}`).toBe(row.score);
      }
    }
  });
});

describe("anchor rounding ignores binary noise", () => {
  it("keeps values that are already exact at two significant figures", () => {
    expect(roundSignificant(0.14, 2, "up")).toBe(0.14);
    expect(roundSignificant(0.29, 2, "down")).toBe(0.29);
    expect(roundSignificant(0.0051, 2, "up")).toBe(0.0051);
    expect(roundSignificant(0.26, 2, "up")).toBe(0.26);
    expect(roundSignificant(0.141, 2, "up")).toBe(0.15); // a real excess still rounds outward
    expect(roundSignificant(0.289, 2, "down")).toBe(0.28);
  });
});
