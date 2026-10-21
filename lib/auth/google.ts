/** The two Google endpoints of the flow: where we send the browser, and where we redeem the code. */

import { AuthError } from "./authError";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The URL that sends the user to Google's sign-in page, carrying everything Google needs to know about this attempt. */
export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code", // authorization code flow: the browser gets a one-time code, not tokens
    client_id: params.clientId, // which app is asking
    redirect_uri: params.redirectUri, // where Google sends the browser back (must match the registered URI)
    scope: "openid email profile", // "openid" is what makes this OpenID Connect and yields an ID token
    state: params.state, // echoed back so we can tell it is our own attempt
    nonce: params.nonce, // copied into the ID token so we can tell it is for this attempt
    code_challenge: params.codeChallenge, // PKCE: the hash of a secret only we know
    code_challenge_method: "S256", // the challenge is SHA-256
  }).toString();
  return url.toString();
}

/**
 * Back channel: our server posts the one-time code to Google, with the PKCE verifier and our
 * client secret, and gets the ID token. This call goes server to server, so the secret and the
 * tokens never pass through the browser. Only the ID token is read; nothing from Google is stored or logged.
 */
export async function exchangeCodeForIdToken(
  params: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", // we are redeeming a code
        code: params.code, // the one-time code from the browser
        code_verifier: params.verifier, // proves we are the app that started this attempt
        client_id: params.clientId,
        client_secret: params.clientSecret, // proves we are the registered app
        redirect_uri: params.redirectUri, // must repeat the one used at the start
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), // never hang a sign-in on Google
    });
  } catch {
    throw new AuthError("token_endpoint_unreachable");
  }
  if (!response.ok) throw new AuthError(`token_endpoint_${response.status}`);

  const body = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (typeof body?.id_token !== "string") throw new AuthError("token_response_invalid");
  return body.id_token;
}
