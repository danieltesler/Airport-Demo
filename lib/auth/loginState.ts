/**
 * The short-lived "login" cookie: what we must remember between sending the user to Google and
 * getting them back (a few minutes). It carries the three one-time values of this attempt:
 *   state     proves the browser that returns is the one that left (stops login CSRF)
 *   nonce     proves the ID token was minted for this attempt (stops token replay)
 *   verifier  the PKCE secret that redeems the code
 * It is a signed JWT so it cannot be forged or edited, with its own audience so it can never be
 * accepted as a session.
 */

import { LOGIN_AUDIENCE, LOGIN_LIFETIME_SECONDS } from "./config";
import { signOurJwt, verifyOurJwt } from "./jwt";

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
}

export function sealLoginState(login: LoginState, now = new Date()): Promise<string> {
  return signOurJwt({ ...login }, LOGIN_AUDIENCE, LOGIN_LIFETIME_SECONDS, now);
}

/** The values saved at login, or null when the cookie is missing, forged, expired or malformed. */
export async function openLoginState(token: string | null, now = new Date()): Promise<LoginState | null> {
  if (!token) return null;
  try {
    const { state, nonce, verifier } = await verifyOurJwt(token, LOGIN_AUDIENCE, now);
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return null;
    return { state, nonce, verifier };
  } catch {
    return null;
  }
}
