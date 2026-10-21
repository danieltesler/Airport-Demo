/**
 * Mint and check OUR OWN JWTs (the session cookie, and the short login cookie).
 * A JWT is three base64url parts: header.payload.signature. The payload is readable by anyone;
 * the signature (HMAC-SHA256 with AUTH_SECRET) is what stops anyone but us from creating or
 * changing one. Google's ID token is a different JWT, checked in idToken.ts.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { OUR_ISSUER, requireSecret } from "./config";

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Sign `claims` as a JWT that says who issued it, who it is for and when it expires. */
export async function signOurJwt(
  claims: JWTPayload,
  audience: string,
  lifetimeSeconds: number,
  now = new Date(),
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" }) // symmetric: the same secret signs and verifies
    .setIssuer(OUR_ISSUER) // "iss": we made it
    .setAudience(audience) // "aud": it is only valid for this purpose
    .setIssuedAt(epochSeconds(now)) // "iat": when it was made
    .setExpirationTime(epochSeconds(now) + lifetimeSeconds) // "exp": after this it is dead
    .sign(requireSecret());
}

/** Check signature, issuer, audience and expiry; throws if any is wrong. Returns the claims. */
export async function verifyOurJwt(token: string, audience: string, now = new Date()): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, requireSecret(), {
    algorithms: ["HS256"], // pin the algorithm so a token cannot pick a weaker one (alg "none", RS256 confusion)
    issuer: OUR_ISSUER,
    audience,
    requiredClaims: ["exp", "iat"], // a token without an expiry would live forever
    currentDate: now,
  });
  return payload;
}
