import { beforeEach, describe, expect, it } from "vitest";
import { airportWeather, ceilingFeet, flightCategory } from "./weather";
import { fixture, makeDeps, mockFetch, resetLiveState, type ScriptedResponse } from "./testing";

beforeEach(resetLiveState);

// Real captures from aviationweather.gov for KJFK on 2026-10-18 (TAF trimmed to 4 periods).
const metar = fixture("metar-kjfk.real.json");
const taf = fixture("taf-kjfk.real.json");

const routes = (m: ScriptedResponse, t: ScriptedResponse): [string, ScriptedResponse][] => [
  ["/metar", m],
  ["/taf", t],
];

describe("flightCategory / ceilingFeet", () => {
  it.each([
    [null, null, null],
    [5000, 10, "VFR"],
    [3000, 10, "MVFR"],
    [null, 4, "MVFR"],
    [900, 10, "IFR"],
    [null, 2, "IFR"],
    [400, 10, "LIFR"],
    [null, 0.5, "LIFR"],
  ])("ceiling %s ft / vis %s sm -> %s", (ceiling, vis, expected) => {
    expect(flightCategory(ceiling as number | null, vis as number | null)).toBe(expected);
  });

  it("uses the lowest BKN/OVC layer and ignores FEW/SCT", () => {
    expect(
      ceilingFeet([{ cover: "FEW", base: 800 }, { cover: "BKN", base: 2500 }, { cover: "OVC", base: 1200 }]),
    ).toBe(1200);
    expect(ceilingFeet([{ cover: "SCT", base: 900 }])).toBeNull();
  });
});

describe("airport_weather tool", () => {
  it("summarizes a real METAR and TAF", async () => {
    const { fetchImpl } = mockFetch(routes({ body: metar }, { body: taf }));
    const out = await airportWeather({ iata: "JFK" }, makeDeps(fetchImpl));
    expect(out.result).toMatchObject({ available: true, station: "KJFK" });
    expect(out.result.metar).toMatchObject({
      flight_category: "VFR",
      wind_direction_deg: 40,
      wind_speed_kt: 9,
      visibility_sm: 10,
      ceiling_ft: null,
      temperature_c: 10,
      observed_utc: "2026-10-18T13:51:00.000Z",
    });
    expect(out.result.taf).toMatchObject({ forecast_periods: 4, worst_flight_category_in_forecast: "VFR" });
    expect(out.result.gaps).toBeUndefined();
    expect(JSON.stringify(out.result).length).toBeLessThan(2500); // small aggregate, not a payload dump
  });

  it("builds URLs from the validated station id only", async () => {
    const mock = mockFetch(routes({ body: metar }, { body: taf }));
    await airportWeather({ iata: "jfk" }, makeDeps(mock.fetchImpl));
    expect(mock.calls.sort()).toEqual([
      "https://aviationweather.gov/api/data/metar?ids=KJFK&format=json",
      "https://aviationweather.gov/api/data/taf?ids=KJFK&format=json",
    ]);
  });

  it("still returns the METAR when the TAF fails", async () => {
    const { fetchImpl } = mockFetch(routes({ body: metar }, { status: 500 }));
    const out = await airportWeather({ iata: "JFK" }, makeDeps(fetchImpl));
    expect(out.result.available).toBe(true);
    expect(out.result.taf).toBeNull();
    expect(out.result.gaps).toEqual([expect.stringContaining("TAF")]);
  });

  it("is unavailable when both fail", async () => {
    const { fetchImpl } = mockFetch(routes({ status: 503 }, { status: 503 }));
    const out = await airportWeather({ iata: "JFK" }, makeDeps(fetchImpl));
    expect(out.result).toMatchObject({ available: false });
    expect(String(out.result.message)).toContain("HTTP 503");
  });

  it("is unavailable when the station has no data (empty array / empty body)", async () => {
    for (const body of ["[]", ""]) {
      resetLiveState();
      const { fetchImpl } = mockFetch(routes({ body }, { body }));
      const out = await airportWeather({ iata: "JFK" }, makeDeps(fetchImpl));
      expect(out.result.available).toBe(false);
      expect(String(out.result.message)).toMatch(/no current METAR or TAF/);
    }
  });

  it("is unavailable on malformed bodies", async () => {
    const { fetchImpl } = mockFetch(routes({ body: "{not json" }, { body: '{"a":1}' }));
    const out = await airportWeather({ iata: "JFK" }, makeDeps(fetchImpl));
    expect(out.result.available).toBe(false);
  });

  it("rejects bad input without a network call", async () => {
    const mock = mockFetch([]);
    expect((await airportWeather({ iata: "KJFK" }, makeDeps(mock.fetchImpl))).result.error).toBeTruthy();
    expect(mock.calls).toHaveLength(0);
  });
});
