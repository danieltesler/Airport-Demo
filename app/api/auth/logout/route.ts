import { SESSION_COOKIE } from "@/lib/auth/config";
import { NextResponse } from "next/server";
import { clearCookie } from "@/lib/auth/responses";
import { rejectCrossSite } from "@/lib/requestGuards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout — forget the session. POST (not GET) so a link or image on another site cannot sign anyone out. */
export function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  const response = NextResponse.json({ signedIn: false }, { headers: { "Cache-Control": "no-store" } });
  clearCookie(response, SESSION_COOKIE);
  return response;
}
