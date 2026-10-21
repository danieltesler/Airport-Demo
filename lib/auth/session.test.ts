/** Our own session JWT, and the central guard that every protected route calls. */

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_AUDIENCE, OUR_ISSUER, SESSION_AUDIENCE, SESSION_COOKIE } from "./config";
import { sealLoginState } from "./loginState";
import { createSessionToken, currentUser, readSessionToken, requireUser } from "./session";
import { TEST_SECRET, setAuthEnv } from "./testing";

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setAuthEnv();
});
afterEach(() => restoreEnv());

const ada = { sub: "google-sub-123", email: "ada@example.com", name: "Ada Lovelace", picture: "https://lh3.googleusercontent.com/a/ada" };
const HOUR_MS = 60 * 60 * 1000;
const withCookie = (token: string) => new Request("http://localhost/api/chat", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` } });

/** A session-shaped token signed with `secret`, with each claim overridable. */
async function craftToken(overrides: { secret?: string; issuer?: string; audience?: string; alg?: string; expiresIn?: number } = {}) {
  const key = new TextEncoder().encode(overrides.secret ?? TEST_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: ada.email, name: ada.name })
    .setProtectedHeader({ alg: overrides.alg ?? "HS256" })
    .setSubject(ada.sub)
    .setIssuer(overrides.issuer ?? OUR_ISSUER)
    .setAudience(overrides.audience ?? SESSION_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresIn ?? 3600))
    .sign(key);
}

describe("session JWT", () => {
  it("round-trips the identity", async () => {
    expect(await readSessionToken(await createSessionToken(ada))).toEqual(ada);
  });

  it("carries issuer, audience, subject, email, name, iat and an 8 hour exp", async () => {
    const token = await createSessionToken(ada, new Date(1_800_000_000_000));
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ iss: "airport-demo", aud: "airport-demo-api", sub: ada.sub, email: ada.email, name: ada.name, iat: 1_800_000_000 });
    expect(payload.exp - payload.iat).toBe(8 * 60 * 60);
  });

  it("is valid just before 8 hours and expired after", async () => {
    const issuedAt = new Date();
    const token = await createSessionToken(ada, issuedAt);
    expect(await readSessionToken(token, new Date(issuedAt.getTime() + 7 * HOUR_MS))).not.toBeNull();
    expect(await readSessionToken(token, new Date(issuedAt.getTime() + 9 * HOUR_MS))).toBeNull();
  });

  it("rejects a token whose payload was edited", async () => {
    const [header, , signature] = (await createSessionToken(ada)).split(".");
    const edited = Buffer.from(JSON.stringify({ iss: OUR_ISSUER, aud: SESSION_AUDIENCE, sub: "admin", email: "boss@example.com", exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 })).toString("base64url");
    expect(await readSessionToken(`${header}.${edited}.${signature}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    expect(await readSessionToken(await craftToken({ secret: "another-secret-another-secret-another-secret" }))).toBeNull();
  });

  it("rejects a token for another audience, including our own login cookie", async () => {
    expect(await readSessionToken(await craftToken({ audience: "some-other-api" }))).toBeNull();
    const loginCookie = await sealLoginState({ state: "s", nonce: "n", verifier: "v" });
    expect(await readSessionToken(loginCookie)).toBeNull();
    expect(LOGIN_AUDIENCE).not.toBe(SESSION_AUDIENCE);
  });

  it("rejects a token from another issuer", async () => {
    expect(await readSessionToken(await craftToken({ issuer: "https://evil.example.com" }))).toBeNull();
  });

  it("rejects an already expired token", async () => {
    expect(await readSessionToken(await craftToken({ expiresIn: -10 }))).toBeNull();
  });

  it("rejects a token that names a different algorithm", async () => {
    expect(await readSessionToken(await craftToken({ alg: "HS512" }))).toBeNull();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${(await craftToken()).split(".")[1]}.`;
    expect(await readSessionToken(unsigned)).toBeNull();
  });

  it("rejects garbage and empty input", async () => {
    for (const token of ["", "not-a-jwt", "a.b.c", null]) expect(await readSessionToken(token)).toBeNull();
  });

  it("refuses to run with a missing or short AUTH_SECRET", async () => {
    const token = await createSessionToken(ada);
    for (const secret of [undefined, "", "too-short"]) {
      const restore = setAuthEnv({ AUTH_SECRET: secret });
      try {
        expect(await readSessionToken(token)).toBeNull();
        await expect(createSessionToken(ada)).rejects.toMatchObject({ reason: "not_configured" });
      } finally {
        restore();
      }
    }
  });
});

describe("currentUser", () => {
  it("reads the user from the session cookie among other cookies", async () => {
    const request = new Request("http://localhost/x", { headers: { cookie: `a=1; ${SESSION_COOKIE}=${await createSessionToken(ada)}; b=2` } });
    expect(await currentUser(request)).toEqual(ada);
  });

  it("fails closed when the cookie name appears twice and the first value is bad", async () => {
    const request = new Request("http://localhost/x", { headers: { cookie: `${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${await createSessionToken(ada)}` } });
    expect(await currentUser(request)).toBeNull();
  });

  it("is null without a cookie", async () => {
    expect(await currentUser(new Request("http://localhost/x"))).toBeNull();
  });
});

describe("requireUser (the guard)", () => {
  it("lets everything through when AUTH_REQUIRED is false or unset", async () => {
    for (const value of ["false", undefined, "", "0", "off"]) {
      const restore = setAuthEnv({ AUTH_REQUIRED: value });
      try {
        expect(await requireUser(new Request("http://localhost/api/chat", { method: "POST" }))).toBeNull();
      } finally {
        restore();
      }
    }
  });

  it("returns 401 {error: unauthorized} with no cookie when AUTH_REQUIRED is true", async () => {
    const response = await requireUser(new Request("http://localhost/api/chat", { method: "POST" }));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "unauthorized" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 401 for a tampered, expired, wrong-audience or garbage cookie", async () => {
    const valid = await createSessionToken(ada);
    const tampered = `${valid.slice(0, -4)}AAAA`;
    for (const token of [tampered, await craftToken({ expiresIn: -10 }), await craftToken({ audience: "other" }), "garbage"]) {
      expect((await requireUser(withCookie(token)))?.status).toBe(401);
    }
  });

  it("lets a valid session through", async () => {
    expect(await requireUser(withCookie(await createSessionToken(ada)))).toBeNull();
  });

  it("treats any value that is not clearly off as on, so a typo does not open the API", async () => {
    const restore = setAuthEnv({ AUTH_REQUIRED: "ture" });
    try {
      expect((await requireUser(new Request("http://localhost/api/chat", { method: "POST" })))?.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("denies everyone when the secret is missing, instead of letting requests through", async () => {
    const token = await createSessionToken(ada);
    const restore = setAuthEnv({ AUTH_SECRET: undefined });
    try {
      expect((await requireUser(withCookie(token)))?.status).toBe(401);
    } finally {
      restore();
    }
  });
});
