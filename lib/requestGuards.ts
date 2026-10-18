/**
 * Small guards shared by the /api routes that trigger paid calls (chat, stt, tts).
 * They are speed bumps against cost abuse, not authentication.
 */

/**
 * Reject requests a browser marks as coming from another site. Browsers always send
 * `Sec-Fetch-Site`; the app's own pages send `same-origin`. A request without the header is a
 * non-browser client (curl, a script), which this check cannot and does not try to stop: it
 * keeps other websites from driving a visitor's browser into spending our credits.
 */
export function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin") return null;
  return Response.json({ reply: "That request isn't allowed from here.", error: "forbidden" }, { status: 403 });
}

/**
 * The client key for rate limits: the first `x-forwarded-for` entry. Vercel overwrites this
 * header with the real client address, so on that host it cannot be spoofed; elsewhere a caller
 * can rotate it, which is why the global budget is the real bound.
 */
export function clientId(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** Largest request body the JSON routes read, in bytes (a message, 12 turns and their notes fit well inside). */
export const MAX_JSON_BODY_BYTES = 100_000;

/** True when the declared Content-Length is over `limit`. A missing header is checked after reading. */
export function declaredTooLarge(request: Request, limit: number): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limit;
}
