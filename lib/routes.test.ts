import { describe, expect, it } from "vitest";
import { dataYear, getAirport } from "./data";
import { loadRoutes, routesFrom } from "./routes";

describe("route rows (data/routes.json)", () => {
  it("loads once and keeps the column order the loader expects", async () => {
    const first = loadRoutes();
    expect(loadRoutes()).toBe(first); // memoized: the 2 MB file is parsed once
    const rows = await first;
    expect(rows.length).toBeGreaterThan(10_000);
    expect(Object.keys(rows[0])).toEqual(["year", "origin", "dest", "carrier", "distance_mi", "seats", "passengers", "departures"]);
  });

  it("adds up to the airport's passengers for the data year", async () => {
    const year = dataYear();
    for (const iata of ["BOS", "OAK", "BTV"]) {
      const total = (await routesFrom(iata.toLowerCase(), year)).reduce((sum, r) => sum + r.passengers, 0);
      expect(total).toBe(getAirport(iata)!.annual_passengers);
    }
  });

  it("carries the previous year for trend questions", async () => {
    const previous = await routesFrom("OAK", dataYear() - 1);
    expect(previous.length).toBeGreaterThan(0);
  });
});
