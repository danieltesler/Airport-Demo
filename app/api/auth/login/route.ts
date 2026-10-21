import { handleLogin } from "@/lib/auth/login";

// jose and node:crypto need the Node.js runtime; the result is different for every request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/login — start "Sign in with Google" (a plain link in the UI, not a fetch). */
export function GET() {
  return handleLogin();
}
