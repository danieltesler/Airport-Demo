import { NextResponse } from "next/server";
import { dataVintage } from "@/lib/data";
import { flightsNearAirport, isOpenSkyConfigured } from "@/lib/opensky";

export const runtime = "nodejs";

// GET /api/health — liveness + dataset vintage + optional-feature status.
// Add ?live=1 to actually exercise the OpenSky call and surface any error.
export async function GET(request: Request) {
  const base = {
    status: "ok",
    data_vintage: dataVintage(),
    live_flights_configured: isOpenSkyConfigured(),
  };

  const runLiveCheck = new URL(request.url).searchParams.get("live");
  if (!runLiveCheck) return NextResponse.json(base);

  try {
    const r = await flightsNearAirport(37.62, -122.38); // SFO
    return NextResponse.json({ ...base, live_check: { ok: true, total: r.total } });
  } catch (e) {
    return NextResponse.json({ ...base, live_check: { ok: false, error: (e as Error).message } });
  }
}
