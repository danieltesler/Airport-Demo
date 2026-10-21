import { handleCallback } from "@/lib/auth/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/callback — where Google sends the browser back. Register this URL in Google Cloud Console. */
export function GET(request: Request) {
  return handleCallback(request);
}
