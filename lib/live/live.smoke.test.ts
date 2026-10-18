/**
 * OPT-IN live smoke test against the real public APIs. Skipped in normal `npm test`
 * (the unit tests use mocked fetch and never touch the network).
 *
 *   LIVE_SMOKE=1 npx vitest run lib/live/live.smoke.test.ts
 *   LIVE_ALL=1 also checks every airport in the dataset
 *   (set CENSUS_API_KEY as well to exercise metro_population)
 */

import { describe, expect, it, vi } from "vitest";
import { allAirports, getAirport } from "../data";
import { runLiveTool } from "./index";

vi.setConfig({ testTimeout: 20_000 }); // real networks are slower than unit tests
const live = process.env.LIVE_SMOKE ? describe : describe.skip;

live("live public APIs (network)", () => {
  const codes = process.env.LIVE_ALL ? allAirports().map((a) => a.iata) : ["BOS", "ANC", "LAX", "ORD", "MIA"];

  it.each(codes)("bts_airport_traffic %s", async (iata) => {
    const out = await runLiveTool("bts_airport_traffic", { iata });
    expect(out.result.available, JSON.stringify(out.result)).toBe(true);
  });

  it.each(codes)("faa_airport_infrastructure %s", async (iata) => {
    const out = await runLiveTool("faa_airport_infrastructure", { iata });
    expect(out.result.available, JSON.stringify(out.result)).toBe(true);
    expect(out.result.runway_count).toBeGreaterThan(0);
  });

  it.each(codes)("airport_weather %s", async (iata) => {
    const out = await runLiveTool("airport_weather", { iata });
    expect(out.result.available, JSON.stringify(out.result)).toBe(true);
  });

  it("faa_airport_status", async () => {
    const out = await runLiveTool("faa_airport_status", { iata: "JFK" });
    expect(out.result.available, JSON.stringify(out.result)).toBe(true);
  });

  it.skipIf(!process.env.CENSUS_API_KEY)("metro_population BOS", async () => {
    const out = await runLiveTool("metro_population", { iata: "BOS" });
    expect(out.result.available, JSON.stringify(out.result)).toBe(true);
  });

  it("dataset airports resolve", () => {
    expect(getAirport("BOS")).toBeTruthy();
  });
});
