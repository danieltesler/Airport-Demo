/**
 * Route-tool arithmetic on a tiny hand-made route table, so every expected figure can be
 * checked with a calculator. The real table is exercised in routeTools.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import type { RouteRow } from "./routes";

const row = (
  year: number, dest: string, carrier: string, distance_mi: number, seats: number, passengers: number, departures: number,
): RouteRow => ({ year, origin: "BOS", dest, carrier, distance_mi, seats, passengers, departures });

const FIXTURE: RouteRow[] = [
  row(2024, "LAX", "WN", 2611, 1000, 800, 10),
  row(2024, "LAX", "DL", 2611, 500, 400, 5),
  row(2024, "ORD", "UA", 867, 2000, 1500, 20),
  row(2024, "SFO", "AS", 2704, 300, 200, 3),
  row(2025, "LAX", "WN", 2611, 600, 500, 6),
  row(2025, "LAX", "DL", 2611, 600, 450, 6),
  row(2025, "ORD", "UA", 867, 2200, 1900, 22),
  row(2025, "MIA", "NK", 1258, 400, 300, 4),
];

vi.mock("./routes", () => ({
  loadRoutes: async () => FIXTURE,
  routesFrom: async (origin: string, year?: number) =>
    FIXTURE.filter((r) => r.origin === origin.trim().toUpperCase() && (year === undefined || r.year === year)),
}));

import { capacityTrend, carrierShare, routeSearch } from "./routeTools";

const records = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

describe("capacity_trend arithmetic", () => {
  // By destination, 2024 -> 2025 (seats / passengers):
  //   LAX 1500/1200 -> 1200/950   change -300 (-20.0%) / -250 (-20.8%)
  //   ORD 2000/1500 -> 2200/1900  change +200 (+10.0%) / +400 (+26.7%)
  //   MIA    0/0    ->  400/300   new
  //   SFO  300/200  ->    0/0     ended (-100.0%)
  // Totals: seats 3800 -> 3800 (0.0%), passengers 2900 -> 3150 (+250, +8.6%).
  it("totals and the biggest increases and cuts by destination", async () => {
    const out = await capacityTrend({ origin: "BOS" });
    expect(out.result.totals).toEqual({
      seats_prior: 3800, seats_current: 3800, seats_change: 0, seats_change_pct: 0,
      passengers_prior: 2900, passengers_current: 3150, passengers_change: 250, passengers_change_pct: 8.6,
    });
    const increases = records(out.result.biggest_increases);
    expect(increases.map((r) => r.key)).toEqual(["MIA", "ORD"]);
    expect(increases[0]).toMatchObject({ seats_change: 400, seats_change_pct: null, status: "new", passengers_current: 300 });
    expect(increases[1]).toMatchObject({ seats_change: 200, seats_change_pct: 10, passengers_change: 400, passengers_change_pct: 26.7 });
    const cuts = records(out.result.biggest_cuts);
    expect(cuts.map((r) => r.key)).toEqual(["LAX", "SFO"]); // equal 300-seat cuts: ordered by code
    expect(cuts[0]).toMatchObject({ seats_prior: 1500, seats_current: 1200, seats_change_pct: -20, passengers_change: -250, passengers_change_pct: -20.8 });
    expect(cuts[1]).toMatchObject({ seats_change_pct: -100, status: "ended" });
    expect(out.result.groups_with_increase).toBe(2);
    expect(out.result.groups_with_cut).toBe(2);
  });

  // By carrier: WN 1000->600 (-400), DL 500->600 (+100), UA 2000->2200 (+200), AS 300->0 (-300), NK 0->400 (+400).
  it("breaks the change down by carrier and caps each list", async () => {
    const out = await capacityTrend({ origin: "BOS", group_by: "carrier", top_n: 1 });
    expect(records(out.result.biggest_increases).map((r) => r.key)).toEqual(["NK"]);
    expect(records(out.result.biggest_cuts).map((r) => r.key)).toEqual(["WN"]);
    expect(out.result.groups_with_increase).toBe(3);
    expect(out.result.row_count).toBe(5);
    expect(out.result.returned).toBe(2);
    expect(out.result.truncated).toBe(true);
  });

  it("reads one route (LAX) by carrier", async () => {
    const out = await capacityTrend({ origin: "BOS", destination: "LAX" });
    expect(out.result.group_by).toBe("carrier");
    expect(out.result.totals).toMatchObject({ seats_prior: 1500, seats_current: 1200, seats_change: -300, seats_change_pct: -20 });
    expect(records(out.result.biggest_increases).map((r) => r.key)).toEqual(["DL"]);
    expect(records(out.result.biggest_cuts).map((r) => r.key)).toEqual(["WN"]);
  });

  it("rejects a destination that is neither covered nor in the route data", async () => {
    const out = await capacityTrend({ origin: "BOS", destination: "QQQ" });
    expect(out.result.error).toBeTruthy();
    expect(out.structured).toBeUndefined();
  });
});

describe("carrier_share arithmetic", () => {
  // 2025 seats total 3800: UA 2200 (57.9%), then WN and DL tied at 600 (15.8% each; the tie goes
  // to the lower code, DL), NK 400 (10.5%). With top 2 the 'other' bucket is WN + NK = 1000 (26.3%).
  it("computes shares and the other bucket from what is left of 100%", async () => {
    const out = await carrierShare({ origin: "BOS", top_n: 2 });
    expect(records(out.result.carriers).map((c) => [c.code, c.seat_share_pct])).toEqual([["UA", 57.9], ["DL", 15.8]]);
    expect(out.result.other).toMatchObject({ carrier_count: 2, seats: 1000, seat_share_pct: 26.3, departures: 10, departure_share_pct: 26.3 });
  });

  it("states the share of departures as well", async () => {
    // departures 2025: UA 22, DL 6, WN 6, NK 4 = 38; UA 57.9%, DL 15.8%.
    const out = await carrierShare({ origin: "BOS", top_n: 2 });
    expect(records(out.result.carriers).map((c) => c.departure_share_pct)).toEqual([57.9, 15.8]);
  });
});

describe("route_search arithmetic", () => {
  it("ranks 2025 routes by passengers with the change from 2024 and a note for a new route", async () => {
    const out = await routeSearch({ origin: "BOS", top_n: 2 });
    const routes = records(out.result.routes);
    expect(routes.map((r) => [r.destination, r.passengers, r.seats, r.departures, r.distance_mi, r.yoy_pct])).toEqual([
      ["ORD", 1900, 2200, 22, 867, 26.7], // 1900 / 1500 - 1
      ["LAX", 950, 1200, 12, 2611, -20.8], // 950 / 1200 - 1
    ]);
    expect(out.result.row_count).toBe(3);
    expect(out.result.truncated).toBe(true);

    const all = records((await routeSearch({ origin: "BOS" })).result.routes);
    expect(all[2]).toMatchObject({ destination: "MIA", yoy_pct: null, yoy_note: "no service in 2024" });
  });

  it("ranks 2024 routes by seats without a change column", async () => {
    const out = await routeSearch({ origin: "BOS", year: 2024, sort_by: "seats" });
    expect(records(out.result.routes).map((r) => [r.destination, r.seats])).toEqual([["ORD", 2000], ["LAX", 1500], ["SFO", 300]]);
  });
});
