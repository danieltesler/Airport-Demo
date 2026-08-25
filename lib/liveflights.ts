/**
 * Live "aircraft near an airport right now" via the adsb.lol community ADS-B API.
 *
 * This is a free, no-auth public API on cloud-friendly infrastructure, which matters
 * for serverless hosting: OpenSky's server refuses connections from datacenter IPs,
 * so it can't be reached from Vercel, whereas adsb.lol can. Same idea, source that
 * works in production.
 *
 * Docs: https://api.adsb.lol/docs — GET /v2/lat/{lat}/lon/{lon}/dist/{nm}
 */

const BASE = "https://api.adsb.lol/v2";
const RADIUS_NM = 30; // "near the airport"

// adsb.lol rejects generic User-Agents (403) and asks for identifying contact info.
const USER_AGENT =
  "airport-investment-intelligence (https://github.com/danieltesler/Airport-Demo)";

export interface LiveFlight {
  callsign: string;
  altitudeFt: number | null;
  onGround: boolean;
}

export interface LiveFlightsResult {
  airborne: number;
  onGround: number;
  total: number;
  sample: LiveFlight[];
}

interface AdsbAircraft {
  flight?: string;
  alt_baro?: number | "ground";
}

/** Live aircraft currently within ~30 nm of the given airport coordinates. */
export async function flightsNearAirport(lat: number, lon: number): Promise<LiveFlightsResult> {
  const response = await fetch(`${BASE}/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Live flight feed returned ${response.status}`);
  }

  const data = (await response.json()) as { ac?: AdsbAircraft[] };
  const aircraft = data.ac ?? [];

  const flights: LiveFlight[] = aircraft.map((a) => ({
    callsign: (a.flight ?? "").trim() || "(unknown)",
    altitudeFt: typeof a.alt_baro === "number" ? a.alt_baro : null,
    onGround: a.alt_baro === "ground",
  }));

  const airborneFlights = flights.filter((f) => !f.onGround);
  return {
    airborne: airborneFlights.length,
    onGround: flights.length - airborneFlights.length,
    total: flights.length,
    sample: airborneFlights.slice(0, 6),
  };
}
