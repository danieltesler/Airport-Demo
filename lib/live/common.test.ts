import { beforeEach, describe, expect, it } from "vitest";
import { LiveFetchError, TtlCache, fetchJson, fetchText, lookupAirport, normalizeIata } from "./common";
import { makeDeps, mockFetch, resetLiveState } from "./testing";

beforeEach(resetLiveState);

describe("normalizeIata", () => {
  it("accepts 3 letters in any case", () => {
    expect(normalizeIata(" bos ")).toBe("BOS");
  });
  it.each(["", "BO", "BOST", "B0S", "BOS'; DROP", "../etc", 42, null, undefined, { iata: "BOS" }])(
    "rejects %j",
    (bad) => {
      expect(normalizeIata(bad)).toBeNull();
    },
  );
});

describe("lookupAirport", () => {
  const deps = makeDeps(mockFetch([]).fetchImpl);
  it("returns the airport for a known code", () => {
    const res = lookupAirport({ iata: "bos" }, deps);
    expect(res.ok && res.airport.icao).toBe("KBOS");
  });
  it("returns a clear error for an unknown code", () => {
    const res = lookupAirport({ iata: "ZZZ" }, deps);
    expect(!res.ok && res.output.result.error).toMatch(/not in the dataset/);
  });
  it("returns a clear error for malformed input", () => {
    const res = lookupAirport({ iata: "free text" }, deps);
    expect(!res.ok && res.output.result.error).toMatch(/3-letter IATA/);
  });
});

describe("fetchText / fetchJson", () => {
  it("maps HTTP errors to a status-only message (no URL)", async () => {
    const { fetchImpl } = mockFetch([["secret-host", { status: 500, body: "boom" }]]);
    const err = await fetchText("https://secret-host/x?key=SUPERSECRET", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveFetchError);
    expect(err.message).toBe("upstream returned HTTP 500");
    expect(err.message).not.toContain("SUPERSECRET");
  });

  it("treats a redirect as failure", async () => {
    const { fetchImpl } = mockFetch([["x", { status: 302 }]]);
    await expect(fetchText("https://x/", { fetchImpl })).rejects.toThrow(/redirected/);
  });

  it("maps network errors to 'unreachable' without leaking details", async () => {
    const { fetchImpl } = mockFetch([["x", { throws: new Error("ECONNRESET to 10.0.0.1") }]]);
    await expect(fetchText("https://x/", { fetchImpl })).rejects.toThrow("upstream unreachable");
  });

  it("times out", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;
    await expect(fetchText("https://x/", { fetchImpl: hang }, { timeoutMs: 20 })).rejects.toThrow(
      "upstream timed out",
    );
  });

  it("rejects malformed JSON and returns null for an empty body", async () => {
    const bad = mockFetch([["x", { body: "<html>" }]]);
    await expect(fetchJson("https://x/", bad)).rejects.toThrow("malformed JSON");
    const empty = mockFetch([["x", { body: "" }]]);
    expect(await fetchJson("https://x/", empty)).toBeNull();
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the oldest at capacity", () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    expect(cache.get("a", 10)).toBeUndefined();
    expect(cache.get("c", 10)).toBe(3);
    expect(cache.get("c", 1000)).toBeUndefined();
  });
});
