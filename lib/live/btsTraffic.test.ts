import { beforeEach, describe, expect, it } from "vitest";
import { btsAirportTraffic, isContiguous, parseMonthRows, summarizeTraffic } from "./btsTraffic";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./testing";

beforeEach(resetLiveState);

// Real capture: BOS, 24 newest monthly rows (2024-05 .. 2026-04) from data.bts.gov r495-tyji on 2026-10-18.
const bosBody = fixture("bts-t100-bos.real.json");
const bosRows = JSON.parse(bosBody) as Record<string, string>[];
const sum = (rows: Record<string, string>[], key: string) => rows.reduce((acc, r) => acc + Number(r[key]), 0);

describe("T-100 monthly parsing and aggregation", () => {
  it("parses 24 contiguous months, newest first", () => {
    const rows = parseMonthRows(bosRows);
    expect(rows).toHaveLength(24);
    expect(rows[0].month).toBe("2026-04");
    expect(rows[23].month).toBe("2024-05");
    expect(isContiguous(rows)).toBe(true);
  });

  it("computes trailing-12 and prior-12 sums independently of the code under test", () => {
    const summary = summarizeTraffic(parseMonthRows(bosRows))!;
    expect(summary.trailing12.passengers).toBe(sum(bosRows.slice(0, 12), "total_passengers"));
    expect(summary.trailing12.departures).toBe(sum(bosRows.slice(0, 12), "total_departures"));
    expect(summary.prior12!.passengers).toBe(sum(bosRows.slice(12, 24), "total_passengers"));
    const expectedGrowth =
      sum(bosRows.slice(0, 12), "total_passengers") / sum(bosRows.slice(12, 24), "total_passengers") - 1;
    expect(summary.passengerGrowthYoy).toBeCloseTo(expectedGrowth, 4);
    expect(summary.trailing12.loadFactor).toBeCloseTo(
      sum(bosRows.slice(0, 12), "total_passengers") / sum(bosRows.slice(0, 12), "total_seats"),
      3,
    );
    expect(summary.trailing12.from).toBe("2025-05");
    expect(summary.trailing12.to).toBe("2026-04");
  });

  it("keeps one row per month (a duplicate is dropped, not summed) and skips unusable rows", () => {
    const rows = parseMonthRows([
      { reporting_month: "2026-01-01T00:00:00.000", total_passengers: "10", total_departures: "2", total_seats: "20" },
      { reporting_month: "2026-01-01T00:00:00.000", total_passengers: "5", total_departures: "1", total_seats: "10" },
      { reporting_month: "2026-02-01T00:00:00.000", total_passengers: "n/a", total_departures: "1", total_seats: "10" },
      {},
    ]);
    expect(rows).toEqual([{ month: "2026-01", passengers: 10, departures: 2, seats: 20, domesticPassengers: 0 }]);
  });

  it("returns no growth when only 12-23 months exist, and null when a gap breaks the window", () => {
    const twelve = parseMonthRows(bosRows.slice(0, 12));
    const partial = summarizeTraffic(twelve)!;
    expect(partial.prior12).toBeNull();
    expect(partial.passengerGrowthYoy).toBeNull();

    const gapped = parseMonthRows([...bosRows.slice(0, 5), ...bosRows.slice(6, 18)]);
    expect(summarizeTraffic(gapped)).toBeNull();
    expect(summarizeTraffic(parseMonthRows(bosRows.slice(0, 11)))).toBeNull();
  });

  it("rejects a non-array body", () => {
    expect(() => parseMonthRows({ error: true })).toThrow(/unexpected shape/);
  });
});

describe("bts_airport_traffic tool", () => {
  it("returns a small aggregate with source, period and caveats", async () => {
    const { fetchImpl, calls } = mockFetch([["data.bts.gov", { body: bosBody }]]);
    const out = await btsAirportTraffic({ iata: "bos" }, makeDeps(fetchImpl));
    expect(out.result).toMatchObject({ available: true, iata: "BOS", latest_month: "2026-04" });
    expect(out.result.trailing_12_months).toMatchObject({
      period: "2025-05 to 2026-04",
      enplaned_passengers: sum(bosRows.slice(0, 12), "total_passengers"),
    });
    expect(String(out.result.source)).toContain("data.bts.gov");
    expect(out.uncertainty).toContain("2026-04");
    expect(JSON.stringify(out.result).length).toBeLessThan(1500);

    const url = new URL(calls[0]);
    expect(url.searchParams.get("$where")).toBe("origin_airport_code='BOS'");
    expect(url.searchParams.get("$limit")).toBe("28");
  });

  it("caches per airport", async () => {
    const mock = mockFetch([["data.bts.gov", { body: bosBody }]]);
    const deps = makeDeps(mock.fetchImpl);
    await btsAirportTraffic({ iata: "BOS" }, deps);
    await btsAirportTraffic({ iata: "BOS" }, deps);
    expect(mock.calls).toHaveLength(1);
  });

  it("never lets model text reach the query", async () => {
    const mock = mockFetch([]);
    const out = await btsAirportTraffic({ iata: "BOS' OR '1'='1" }, makeDeps(mock.fetchImpl));
    expect(out.result.error).toBeTruthy();
    expect(mock.calls).toHaveLength(0);
  });

  it("reports unavailable on empty result, 500 and malformed JSON", async () => {
    for (const scripted of [{ body: "[]" }, { status: 500, body: "x" }, { body: "<html>" }]) {
      resetLiveState();
      const { fetchImpl } = mockFetch([["data.bts.gov", scripted]]);
      const out = await btsAirportTraffic({ iata: "BOS" }, makeDeps(fetchImpl));
      expect(out.result).toMatchObject({ available: false });
      expect(out.result.trailing_12_months).toBeUndefined();
    }
  });
});
