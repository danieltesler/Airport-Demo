import { NextResponse } from "next/server";
import { dataVintage } from "@/lib/data";
import { flightsNearAirport, isOpenSkyConfigured } from "@/lib/opensky";

export const runtime = "nodejs";

// GET /api/health — liveness + dataset vintage + optional-feature status.
// Add ?live=1 to probe outbound egress and the OpenSky call and surface errors.
export async function GET(request: Request) {
  const base = {
    status: "ok",
    data_vintage: dataVintage(),
    live_flights_configured: isOpenSkyConfigured(),
  };

  if (!new URL(request.url).searchParams.get("live")) return NextResponse.json(base);

  const checks: Record<string, unknown> = {};

  // 1) General outbound egress — can this function reach any external host at all?
  try {
    const r = await fetch("https://api.github.com/zen");
    checks.egress = `ok (${r.status})`;
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    checks.egress = `FAIL: ${err.message} / ${String(err.cause ?? "")}`;
  }

  // 2) The actual OpenSky path, with the underlying cause if it fails.
  try {
    const r = await flightsNearAirport(37.62, -122.38); // SFO
    checks.opensky = { ok: true, total: r.total };
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    checks.opensky = { ok: false, error: err.message, cause: String(err.cause ?? "") };
  }

  return NextResponse.json({ ...base, live_check: checks });
}
