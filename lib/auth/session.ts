/**
 * Our own session: the JWT we issue after a successful Google sign-in, kept in an HttpOnly
 * cookie, and the one central guard (requireUser) that every protected API route calls.
 */

import { AuthError } from "./authError";
import { SESSION_AUDIENCE, SESSION_COOKIE, SESSION_LIFETIME_SECONDS, authRequired } from "./config";
import { signOurJwt, verifyOurJwt } from "./jwt";
import { readCookie } from "./responses";
import type { GoogleIdentity } from "./idToken";

/** The signed-in person, as far as this app knows: what the session JWT carries. */
export type SessionUser = GoogleIdentity;

/** Issue the session JWT. "sub" is Google's stable id for the person; email, name and picture are for display. */
export function createSessionToken(user: SessionUser, now = new Date()): Promise<string> {
  const claims = { sub: user.sub, email: user.email, name: user.name, ...(user.picture ? { picture: user.picture } : {}) };
  return signOurJwt(claims, SESSION_AUDIENCE, SESSION_LIFETIME_SECONDS, now);
}

/** The user in a session token, or null when it is forged, tampered with, expired or meant for something else. */
export async function readSessionToken(token: string | null, now = new Date()): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { sub, email, name, picture } = await verifyOurJwt(token, SESSION_AUDIENCE, now);
    if (typeof sub !== "string" || typeof email !== "string") return null;
    return {
      sub,
      email,
      name: typeof name === "string" && name ? name : email,
      picture: typeof picture === "string" ? picture : null,
    };
  } catch (error) {
    // A missing secret is our own misconfiguration, worth a log line; a bad token is just a stranger.
    if (error instanceof AuthError) console.error("Session check failed:", error.reason);
    return null;
  }
}

/** Who is making this request, from its session cookie; null when nobody valid is. */
export function currentUser(request: Request): Promise<SessionUser | null> {
  return readSessionToken(readCookie(request, SESSION_COOKIE));
}

const UNAUTHORIZED = { error: "unauthorized" };

/**
 * The guard for /api/chat, /api/stt and /api/tts. Returns null to let the request continue, or a
 * ready-made 401 to return at once. When sign-in is switched off (AUTH_REQUIRED unset or
 * "false") it always lets the request through. When it is on, anything but a valid session is denied.
 */
export async function requireUser(request: Request): Promise<Response | null> {
  if (!authRequired()) return null;
  if (await currentUser(request)) return null;
  return Response.json(UNAUTHORIZED, { status: 401, headers: { "Cache-Control": "no-store" } });
}
