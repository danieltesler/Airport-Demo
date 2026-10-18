import { describe, expect, it, vi } from "vitest";
import { compareAirports, rankAirports, runTool } from "./tools";

describe("tool argument validation (code-review findings)", () => {
  it("rank_airports treats a NaN, text or zero top_n as the default and caps a large one", () => {
    for (const bad of [Number.NaN, "lots", 0, -3, undefined, null]) {
      const out = rankAirports("all", "expansion", bad as unknown as number);
      expect(out.result.error).toBeUndefined();
      expect((out.result.ranking as unknown[]).length).toBe(5);
    }
    expect((rankAirports("all", "expansion", 1000).result.ranking as unknown[]).length).toBe(25);
    expect((rankAirports("all", "expansion", 3.9).result.ranking as unknown[]).length).toBe(3);
  });

  it("compare_airports with no arguments returns a clear error, not a TypeError", async () => {
    for (const args of [{}, { iatas: [] }, { iatas: null }, { metric: "congestion" }]) {
      const out = await runTool("compare_airports", args);
      expect(String(out.result.error)).toMatch(/Name at least one airport/);
      expect(String(out.result.error)).not.toMatch(/Cannot read/);
    }
    expect(compareAirports([], "congestion").result.error).toBeTruthy();
  });
});

describe("route data that fails to load", () => {
  it("is not remembered, and is reported as unavailable rather than as bad arguments", async () => {
    vi.resetModules();
    vi.doMock("@/data/routes.json", () => {
      throw new Error("disk read failed");
    });
    const failing = await import("./tools");
    const failed = await failing.runTool("route_search", { origin: "BOS" });
    expect(String(failed.result.error)).toMatch(/route data could not be loaded/i);
    expect(String(failed.result.error)).not.toMatch(/Bad arguments/);

    // The rejection was not cached: once the file loads, the same instance recovers.
    vi.doUnmock("@/data/routes.json");
    vi.resetModules();
    const { loadRoutes, RouteDataError } = await import("./routes");
    expect(await loadRoutes()).not.toHaveLength(0);
    expect(RouteDataError).toBeTruthy();
  });

  it("a failed load raises RouteDataError (not a bad-arguments error)", async () => {
    vi.resetModules();
    let fail = true;
    vi.doMock("@/data/routes.json", () => {
      if (fail) throw new Error("transient");
      return { default: { meta: { columns: ["year", "origin", "dest", "carrier", "distance_mi", "seats", "passengers", "departures"] }, rows: [[2025, "BOS", "LAX", "WN", 2611, 1, 1, 1]] } };
    });
    const routes = await import("./routes");
    await expect(routes.loadRoutes()).rejects.toBeInstanceOf(routes.RouteDataError);
    fail = false;
    vi.resetModules();
    vi.doUnmock("@/data/routes.json");
  });
});
