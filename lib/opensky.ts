/**
 * Minimal OpenSky Network client for the live "flights near an airport right now"
 * tool. OpenSky is a genuine live public API (real-time ADS-B aircraft states).
 *
 * Auth is OAuth2 client-credentials: we exchange a client id/secret for a short-
 * lived bearer token, cached in memory until it nears expiry. If no credentials are
 * configured the client reports itself unconfigured so the tool can degrade
 * gracefully instead of failing.
 */

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

// Half-size of the lat/lon box drawn around an airport (~40 mi). Kept simple.
const BOX_DELTA_DEG = 0.6;

export interface LiveFlight {
  callsign: string;
  altitudeM: number | null;
  velocityMs: number | null;
  onGround: boolean;
}

export interface LiveFlightsResult {
  airborne: number;
  onGround: number;
  total: number;
  sample: LiveFlight[];
}

export function isOpenSkyConfigured(): boolean {
  return Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.OPENSKY_CLIENT_ID ?? "",
    client_secret: process.env.OPENSKY_CLIENT_SECRET ?? "",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`OpenSky auth failed (${response.status})`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("OpenSky auth returned no token");

  cachedToken = {
    value: data.access_token,
    expiresAt: now + (data.expires_in ?? 1800) * 1000,
  };
  return cachedToken.value;
}

/** Live aircraft currently within a box around the given airport coordinates. */
export async function flightsNearAirport(lat: number, lon: number): Promise<LiveFlightsResult> {
  const token = await getToken();
  const params = new URLSearchParams({
    lamin: String(lat - BOX_DELTA_DEG),
    lamax: String(lat + BOX_DELTA_DEG),
    lomin: String(lon - BOX_DELTA_DEG),
    lomax: String(lon + BOX_DELTA_DEG),
  });

  const response = await fetch(`${STATES_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 429) {
    throw new Error("OpenSky rate limit reached — try again shortly");
  }
  if (!response.ok) {
    throw new Error(`OpenSky states request failed (${response.status})`);
  }

  // Each state is a positional array; the indices we use are documented by OpenSky:
  // [1]=callsign, [7]=baro_altitude(m), [8]=on_ground, [9]=velocity(m/s).
  const data = (await response.json()) as { states?: unknown[][] | null };
  const states = data.states ?? [];

  const flights: LiveFlight[] = states.map((s) => ({
    callsign: String(s[1] ?? "").trim() || "(unknown)",
    altitudeM: typeof s[7] === "number" ? s[7] : null,
    velocityMs: typeof s[9] === "number" ? s[9] : null,
    onGround: Boolean(s[8]),
  }));

  const airborneFlights = flights.filter((f) => !f.onGround);
  return {
    airborne: airborneFlights.length,
    onGround: flights.length - airborneFlights.length,
    total: flights.length,
    sample: airborneFlights.slice(0, 6),
  };
}
