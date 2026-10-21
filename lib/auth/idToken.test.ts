/** Google ID token verification against a locally generated key pair. Google is never called. */

import { SignJWT, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "./authError";
import { verifyGoogleIdToken } from "./idToken";
import { TEST_CLIENT_ID, createFakeGoogle, setAuthEnv } from "./testing";

let google: Awaited<ReturnType<typeof createFakeGoogle>>;
beforeAll(async () => {
  google = await createFakeGoogle();
});

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setAuthEnv();
});
afterEach(() => restoreEnv());

const expected = { clientId: TEST_CLIENT_ID, nonce: "nonce-1" };
const verify = (token: string) => verifyGoogleIdToken(token, expected, google.keys);
const now = () => Math.floor(Date.now() / 1000);

/** Rejected with an AuthError whose reason contains `reason`. */
async function expectRejected(token: string, reason: string) {
  const error = await verify(token).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).reason).toContain(reason);
}

describe("verifyGoogleIdToken", () => {
  it("accepts a valid token and returns only the identity", async () => {
    expect(await verify(await google.signIdToken())).toEqual({
      sub: "google-sub-123",
      email: "ada@example.com",
      name: "Ada Lovelace",
      picture: "https://lh3.googleusercontent.com/a/ada",
    });
  });

  it("accepts the issuer without the scheme, which Google also uses", async () => {
    await expect(verify(await google.signIdToken({}, { issuer: "accounts.google.com" }))).resolves.toBeTruthy();
  });

  it("rejects a token for another app (wrong audience)", async () => {
    await expectRejected(await google.signIdToken({}, { audience: "someone-elses-app.apps.googleusercontent.com" }), "aud");
  });

  it("rejects a token from another issuer", async () => {
    await expectRejected(await google.signIdToken({}, { issuer: "https://evil.example.com" }), "iss");
  });

  it("rejects an expired token", async () => {
    await expectRejected(await google.signIdToken({}, { issuedAt: now() - 7200, expiresAt: now() - 3600 }), "id_token_exp");
  });

  it("rejects a token that was issued too long ago, even if it has not expired", async () => {
    await expectRejected(await google.signIdToken({}, { issuedAt: now() - 3000, expiresAt: now() + 600 }), "id_token_iat");
  });

  it("allows up to a minute of clock drift between Google and us, but no more", async () => {
    await expect(verify(await google.signIdToken({}, { issuedAt: now() + 50 }))).resolves.toBeTruthy();
    await expect(verify(await google.signIdToken({}, { issuedAt: now() - 120, expiresAt: now() - 30 }))).resolves.toBeTruthy();
    await expectRejected(await google.signIdToken({}, { issuedAt: now() + 3600, expiresAt: now() + 7200 }), "id_token_iat");
  });

  it("rejects an HS256 token signed with our client secret (algorithm confusion)", async () => {
    const forged = await new SignJWT({ nonce: "nonce-1", email: "ada@example.com", email_verified: true })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("google-sub-123")
      .setIssuer("https://accounts.google.com")
      .setAudience(TEST_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("test-client-secret"));
    await expectRejected(forged, "ALG_NOT_ALLOWED");
  });

  it("rejects a token without an expiry", async () => {
    await expectRejected(await google.signIdToken({}, { expiresAt: null }), "id_token_exp");
  });

  it("rejects a nonce that does not match this login attempt", async () => {
    await expectRejected(await google.signIdToken({ nonce: "replayed-from-another-login" }), "nonce_mismatch");
  });

  it("rejects a token with no nonce", async () => {
    await expectRejected(await google.signIdToken({ nonce: undefined }), "nonce_mismatch");
  });

  it("rejects an unverified email", async () => {
    await expectRejected(await google.signIdToken({ email_verified: false }), "email_not_verified");
  });

  it("rejects an email_verified that is not literally true", async () => {
    await expectRejected(await google.signIdToken({ email_verified: "true" }), "email_not_verified");
  });

  it("rejects a token signed by a key that is not in Google's key set", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    await expectRejected(await google.signIdToken({}, { key: privateKey }), "id_token");
  });

  it("rejects a token that was edited after signing", async () => {
    const [header, , signature] = (await google.signIdToken()).split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ iss: "https://accounts.google.com", aud: TEST_CLIENT_ID, sub: "admin", exp: now() + 3600, iat: now(), nonce: "nonce-1", email: "boss@example.com", email_verified: true }),
    ).toString("base64url");
    await expectRejected(`${header}.${forgedPayload}.${signature}`, "SIGNATURE_VERIFICATION_FAILED");
  });

  it("rejects a token that claims no signature algorithm (alg none)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: TEST_CLIENT_ID, sub: "x", exp: now() + 3600, iat: now(), nonce: "nonce-1", email: "a@b.c", email_verified: true })).toString("base64url");
    await expectRejected(`${header}.${payload}.`, "id_token");
  });

  it("drops a picture that is not an https URL", async () => {
    const identity = await verify(await google.signIdToken({ picture: "javascript:alert(1)" }));
    expect(identity.picture).toBeNull();
  });

  it("falls back to the email when Google sends no name", async () => {
    const identity = await verify(await google.signIdToken({ name: undefined }));
    expect(identity.name).toBe("ada@example.com");
  });
});
