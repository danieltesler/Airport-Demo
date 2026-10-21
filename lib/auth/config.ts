/**
 * Everything the sign-in code reads from the environment, in one place.
 * Variables (names only; see .env.example and the README "Authentication" section):
 *   AUTH_REQUIRED          "true" turns the sign-in guard on; unset or "false" leaves the app open
 *   AUTH_SECRET            signs our own JWTs (HS256); 32+ random characters
 *   AUTH_URL               this app's public origin, e.g. https://airport-demo-pi.vercel.app
 *   GOOGLE_CLIENT_ID       from Google Cloud Console (OAuth client)
 *   GOOGLE_CLIENT_SECRET   from Google Cloud Console (never sent to the browser)
 * Everything is read when it is used, not when the module loads, so a test or a redeploy sees the current values.
 */

import { AuthError } from "./authError";

export const SESSION_COOKIE = "airport_session";
export const LOGIN_COOKIE = "airport_login";

/** Who signed our own JWTs ("iss"), and who they are meant for ("aud"). A token for one audience is useless for the other. */
export const OUR_ISSUER = "airport-demo";
export const SESSION_AUDIENCE = "airport-demo-api";
export const LOGIN_AUDIENCE = "airport-demo-login";

export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
export const LOGIN_LIFETIME_SECONDS = 10 * 60;

export const CALLBACK_PATH = "/api/auth/callback";

const MIN_SECRET_CHARS = 32;
const SWITCHED_OFF = new Set(["", "false", "0", "off", "no"]);

/**
 * Is sign-in enforced? Unset means no. Any value that is not clearly "off" means yes, so a typo
 * such as "ture" locks the API instead of silently opening it.
 */
export function authRequired(): boolean {
  const value = (process.env.AUTH_REQUIRED ?? "").trim().toLowerCase();
  return !SWITCHED_OFF.has(value);
}

/** The HS256 key for our own JWTs. Refuses to run with a missing or short secret, because a weak key makes forged sessions easy. */
export function requireSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < MIN_SECRET_CHARS) throw new AuthError("not_configured");
  return new TextEncoder().encode(secret);
}

/**
 * This app's public origin, from AUTH_URL only, never from the request's Host header (a caller
 * controls that). https is required except for localhost, so cookies and redirects are never
 * built on plain http in production. Returns null when it is unset or unacceptable.
 */
export function appOrigin(): string | null {
  const fallback = process.env.NODE_ENV === "production" ? "" : "http://localhost:3000";
  const configured = process.env.AUTH_URL?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const schemeAllowed = url.protocol === "https:" || (url.protocol === "http:" && isLocalhost);
  if (!schemeAllowed || url.username || url.password) return null;
  return url.origin; // origin only: any path or query in the setting is dropped
}

/** Cookies are marked Secure whenever the app's origin is https; only a localhost http origin is exempt. */
export function secureCookies(): boolean {
  return appOrigin()?.startsWith("http://") !== true;
}

export interface SignInSettings {
  clientId: string;
  clientSecret: string;
  /** The exact URL Google sends the browser back to. It must match one registered in Google Cloud Console. */
  redirectUri: string;
}

/** What the login and callback routes need, or null when anything is missing (the routes then fail closed). */
export function signInSettings(): SignInSettings | null {
  const origin = appOrigin();
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!origin || !clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: new URL(CALLBACK_PATH, origin).href };
}
