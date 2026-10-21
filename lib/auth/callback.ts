/**
 * Step 2 of the flow: Google sends the browser back with a one-time code. Behind GET /api/auth/callback.
 * Every check below fails closed: any problem sends the user home through signInFailed().
 */

import type { JWTVerifyGetKey } from "jose";
import { AuthError } from "./authError";
import { LOGIN_COOKIE, SESSION_COOKIE, SESSION_LIFETIME_SECONDS, signInSettings } from "./config";
import { exchangeCodeForIdToken } from "./google";
import { verifyGoogleIdToken } from "./idToken";
import { openLoginState } from "./loginState";
import { safeEqual } from "./pkce";
import { LOGIN_COOKIE_PATH, clearCookie, readCookie, redirect, setCookie, signInFailed } from "./responses";
import { createSessionToken } from "./session";

/** Swappable so tests never call Google. Production uses the defaults. */
export interface CallbackDependencies {
  exchangeCode?: typeof exchangeCodeForIdToken;
  googleKeys?: JWTVerifyGetKey;
}

export async function handleCallback(request: Request, dependencies: CallbackDependencies = {}): Promise<Response> {
  const exchangeCode = dependencies.exchangeCode ?? exchangeCodeForIdToken;
  const query = new URL(request.url).searchParams;

  // 1. Did Google send a code and our state? (Declining on Google's page comes back as "error".)
  if (query.get("error")) return signInFailed("google_error");
  const code = query.get("code");
  const returnedState = query.get("state");
  if (!code || !returnedState) return signInFailed("missing_params");

  // 2. Recover this attempt's secrets from our own signed cookie. No cookie means this browser never started a login here.
  const attempt = await openLoginState(readCookie(request, LOGIN_COOKIE));
  if (!attempt) return signInFailed("login_cookie_invalid");

  // 3. The state Google echoed must be the one we stored. If not, someone else's login is being pushed into this browser.
  if (!safeEqual(returnedState, attempt.state)) return signInFailed("state_mismatch");

  const settings = signInSettings();
  if (!settings) return signInFailed("not_configured");

  try {
    // 4. Redeem the code on the back channel, proving ourselves with the PKCE verifier and the client secret.
    const idToken = await exchangeCode({
      code,
      verifier: attempt.verifier,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
    });

    // 5. Check Google's signature, issuer, audience, expiry, our nonce and that the email is verified.
    const identity = await verifyGoogleIdToken(idToken, { clientId: settings.clientId, nonce: attempt.nonce }, dependencies.googleKeys);

    // 6. We only wanted to know who this is. Issue our own session and let Google's tokens go out of scope.
    const session = await createSessionToken(identity);

    // 7. Hand the browser our session cookie, drop the one-time login cookie and go to the app.
    const response = redirect("/");
    setCookie(response, SESSION_COOKIE, session, SESSION_LIFETIME_SECONDS);
    clearCookie(response, LOGIN_COOKIE, LOGIN_COOKIE_PATH);
    return response;
  } catch (error) {
    return signInFailed(error instanceof AuthError ? error.reason : "unexpected_error");
  }
}
