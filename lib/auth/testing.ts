/**
 * Helpers for the auth tests: a throwaway Google key pair with a local JWKS, a signer that
 * produces Google-shaped ID tokens, and environment setup. Nothing here calls Google.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const TEST_ORIGIN = "https://airport-demo-pi.vercel.app";
export const TEST_CLIENT_ID = "1234567890-test.apps.googleusercontent.com";
export const TEST_SECRET = "test-secret-test-secret-test-secret-0123456789";

/** Set the auth environment for one test. Returns a function that restores the previous values. */
export function setAuthEnv(overrides: Record<string, string | undefined> = {}): () => void {
  const values: Record<string, string | undefined> = {
    AUTH_REQUIRED: "true",
    AUTH_SECRET: TEST_SECRET,
    AUTH_URL: TEST_ORIGIN,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** A fake Google: signs ID tokens with a private key and offers the matching public JWKS. */
export async function createFakeGoogle(keyId = "test-key-1") {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" }] };
  const keys: JWTVerifyGetKey = createLocalJWKSet(jwks);

  /** An ID token that is valid unless `claims` or `options` break it. */
  async function signIdToken(
    claims: JWTPayload = {},
    options: { issuer?: string; audience?: string; issuedAt?: number; expiresAt?: number | null; key?: CryptoKey } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = new SignJWT({
      nonce: "nonce-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://lh3.googleusercontent.com/a/ada",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setSubject("google-sub-123")
      .setIssuer(options.issuer ?? "https://accounts.google.com")
      .setAudience(options.audience ?? TEST_CLIENT_ID)
      .setIssuedAt(options.issuedAt ?? now);
    if (options.expiresAt !== null) token.setExpirationTime(options.expiresAt ?? now + 3600); // null leaves the claim out
    return token.sign(options.key ?? privateKey);
  }

  return { keys, signIdToken };
}
