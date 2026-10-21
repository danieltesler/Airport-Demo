/**
 * The random values and the PKCE maths of the sign-in flow (RFC 7636).
 * Server-only: uses node:crypto.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A URL-safe random string from the operating system's secure random source. 32 bytes is 256 bits. */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * PKCE: the challenge is the SHA-256 hash of the verifier, base64url-encoded. We send the
 * challenge to Google first and the verifier only when we redeem the code, so a thief who
 * intercepts the code on its way back cannot redeem it without the verifier.
 */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Compare two secrets in constant time, so the time taken does not reveal how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
