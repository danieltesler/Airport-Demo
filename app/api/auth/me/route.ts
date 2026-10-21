import { authRequired } from "@/lib/auth/config";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me — what the UI needs to know: is sign-in required, and who is signed in.
 * Open to everyone (it only describes the caller's own cookie), and never cached.
 */
export async function GET(request: Request) {
  const required = authRequired();
  const user = await currentUser(request);
  const body = user
    ? { required, signedIn: true, name: user.name, email: user.email, picture: user.picture }
    : { required, signedIn: false };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
