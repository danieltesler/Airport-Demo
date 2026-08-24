import { NextResponse } from "next/server";
import { dataVintage } from "@/lib/data";

// GET /api/health — liveness + dataset vintage.
export function GET() {
  return NextResponse.json({ status: "ok", data_vintage: dataVintage() });
}
