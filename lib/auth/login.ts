/** Step 1 of the flow: send the browser to Google. Behind GET /api/auth/login. */

import { AuthError } from "./authError";
import { LOGIN_COOKIE, LOGIN_LIFETIME_SECONDS, signInSettings } from "./config";
import { buildAuthorizeUrl } from "./google";
import { sealLoginState } from "./loginState";
import { codeChallengeFor, randomToken } from "./pkce";
import { LOGIN_COOKIE_PATH, redirect, setCookie, signInFailed } from "./responses";

export async function handleLogin(): Promise<Response> {
  const settings = signInSettings();
  if (!settings) return signInFailed("not_configured");

  try {
    // Three one-time secrets for this attempt (see loginState.ts for what each one defends against).
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48); // 64 characters, inside the 43-128 PKCE allows

    // Google gets only the hash of the verifier; the verifier itself stays in our cookie.
    const codeChallenge = codeChallengeFor(verifier);

    // Remember the attempt in a signed, short-lived cookie until Google sends the browser back.
    const response = redirect(
      buildAuthorizeUrl({ clientId: settings.clientId, redirectUri: settings.redirectUri, state, nonce, codeChallenge }),
    );
    setCookie(response, LOGIN_COOKIE, await sealLoginState({ state, nonce, verifier }), LOGIN_LIFETIME_SECONDS, LOGIN_COOKIE_PATH);
    return response;
  } catch (error) {
    return signInFailed(error instanceof AuthError ? error.reason : "login_error");
  }
}
