import { NextResponse } from "next/server";
import { dataVintage } from "@/lib/data";
import { isOpenSkyConfigured } from "@/lib/opensky";

// GET /api/health — liveness, dataset vintage, and whether optional features are set up.
export function GET() {
  return NextResponse.json({
    status: "ok",
    data_vintage: dataVintage(),
    live_flights_configured: isOpenSkyConfigured(),
  });
}
