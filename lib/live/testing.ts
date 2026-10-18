/** Test-only helpers: a scripted fetch (no network) and a tiny airport list. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearLiveCaches, type AirportRef, type LiveDeps } from "./common";

export const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

export const AIRPORTS: Record<string, AirportRef> = {
  BOS: { iata: "BOS", icao: "KBOS", name: "Boston Logan", city: "Boston", state: "MA", lat: 42.362, lon: -71.0079 },
  JFK: { iata: "JFK", icao: "KJFK", name: "John F. Kennedy", city: "New York", state: "NY", lat: 40.6398, lon: -73.7789 },
  SAN: { iata: "SAN", icao: "KSAN", name: "San Diego", city: "San Diego", state: "CA", lat: 32.7336, lon: -117.1897 },
  LAX: { iata: "LAX", icao: "KLAX", name: "Los Angeles", city: "Los Angeles", state: "CA", lat: 33.9425, lon: -118.4081 },
};

export interface ScriptedResponse {
  status?: number;
  body?: string;
  /** Throw instead of responding (network failure). */
  throws?: Error;
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  calls: string[];
}

/** Responds by the first matching `[urlSubstring, response]` pair; unmatched URLs fail the test. */
export function mockFetch(routes: [string, ScriptedResponse][]): MockFetch {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(([needle]) => url.includes(needle));
    if (!route) throw new Error(`Unmocked network call: ${url}`);
    const [, scripted] = route;
    if (scripted.throws) throw scripted.throws;
    return new Response(scripted.body ?? "", { status: scripted.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function makeDeps(fetchImpl: typeof fetch, now = new Date("2026-10-18T14:00:00Z")): LiveDeps {
  return { resolveAirport: (iata) => AIRPORTS[iata], fetchImpl, now: () => now };
}

export const resetLiveState = (): void => clearLiveCaches();
