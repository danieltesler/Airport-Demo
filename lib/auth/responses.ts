/** Cookie and redirect helpers for the auth routes, so every cookie gets the same safe attributes. */

import { NextResponse } from "next/server";
import { LOGIN_COOKIE, secureCookies } from "./config";

/** The login cookie is only needed by the callback, so it is only sent to /api/auth/*. */
export const LOGIN_COOKIE_PATH = "/api/auth";

/** The value of one cookie from the request's Cookie header, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** A redirect. Never cached, so a browser cannot replay an old sign-in redirect. */
export function redirect(location: string): NextResponse {
  return new NextResponse(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

/**
 * Set a cookie with the attributes that matter:
 *  HttpOnly  page scripts cannot read it, so an XSS bug cannot steal it
 *  Secure    sent over https only (localhost http excepted)
 *  SameSite=Lax  not sent on cross-site requests, except top-level navigations such as Google
 *            sending the browser back to our callback (Strict would drop it there)
 */
export function setCookie(response: NextResponse, name: string, value: string, maxAgeSeconds: number, path = "/"): void {
  response.cookies.set(name, value, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path, maxAge: maxAgeSeconds });
}

/** Delete a cookie by overwriting it with an empty value that has already expired. */
export function clearCookie(response: NextResponse, name: string, path = "/"): void {
  setCookie(response, name, "", 0, path);
}

/**
 * Every sign-in failure ends here: log a short reason code, forget the login attempt and send
 * the user home with a generic flag. The page never says why, so nothing leaks to an attacker.
 */
export function signInFailed(reason: string): NextResponse {
  console.warn("Sign-in failed:", reason);
  const response = redirect("/?signin=failed");
  clearCookie(response, LOGIN_COOKIE, LOGIN_COOKIE_PATH);
  return response;
}
