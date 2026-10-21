/**
 * Check the ID token Google hands back. This is the JWT we VERIFY (we do not issue it).
 * Google signs it with its private key (RS256); we check that signature with Google's public
 * keys, published as a JWKS (a list of public keys, each with a "kid" id the token names).
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AuthError } from "./authError";
import { safeEqual } from "./pkce";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Google uses both spellings of its issuer. */
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** The only things we keep from Google: who the person is. No Google token is stored. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

let googleKeys: JWTVerifyGetKey | undefined;

/** Google's public keys, fetched on first use, then cached and refreshed by jose when a token names an unknown key. */
export function googleKeySet(): JWTVerifyGetKey {
  googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleKeys;
}

/**
 * Verify the ID token and return the identity in it. Throws AuthError if anything is off.
 * `keys` is Google's JWKS in production; tests pass a local one.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  keys: JWTVerifyGetKey = googleKeySet(),
  now = new Date(),
): Promise<GoogleIdentity> {
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keys, {
      algorithms: ["RS256"], // Google's algorithm; refuses "none" and symmetric tricks
      issuer: GOOGLE_ISSUERS, // it came from Google
      audience: expected.clientId, // it was issued to OUR app, not another app's token replayed at us
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "10m", // "iat": we redeemed the code seconds ago, so an old token is suspicious (also enforces exp)
      clockTolerance: "60s", // a minute of clock drift between Google and Vercel is normal
      currentDate: now,
    }));
  } catch (error) {
    throw new AuthError(describeJoseFailure(error));
  }

  // The nonce we sent at login must come back unchanged: it ties this token to this login attempt.
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce)) throw new AuthError("nonce_mismatch");
  // Google only vouches for the address when it has verified it; anything else could be someone else's.
  if (claims.email_verified !== true) throw new AuthError("email_not_verified");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new AuthError("claims_missing");

  const picture = typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : null;
  const name = typeof claims.name === "string" && claims.name ? claims.name : claims.email;
  return { sub: claims.sub, email: claims.email, name, picture };
}

/** A log-safe reason such as "id_token_aud": the failing claim or the jose error code, never the token. */
function describeJoseFailure(error: unknown): string {
  if (error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired) return `id_token_${error.claim}`;
  if (error instanceof errors.JOSEError) return `id_token_${error.code}`;
  return "id_token_invalid";
}
