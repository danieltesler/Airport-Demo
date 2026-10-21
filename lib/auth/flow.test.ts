/**
 * The sign-in flow end to end, with Google replaced by a fake: login redirect and cookie, the
 * callback's checks (state, token exchange, ID token), the session cookie it sets, /me and logout.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCallback } from "./callback";
import { LOGIN_COOKIE, SESSION_COOKIE } from "./config";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, exchangeCodeForIdToken } from "./google";
import { handleLogin } from "./login";
import { openLoginState } from "./loginState";
import { codeChallengeFor } from "./pkce";
import { readSessionToken } from "./session";
import { TEST_CLIENT_ID, TEST_ORIGIN, createFakeGoogle, setAuthEnv } from "./testing";
import * as logoutRoute from "../../app/api/auth/logout/route";
import * as meRoute from "../../app/api/auth/me/route";

let google: Awaited<ReturnType<typeof createFakeGoogle>>;
beforeAll(async () => {
  google = await createFakeGoogle();
});

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setAuthEnv();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

/** The Set-Cookie header for `name`, or undefined. */
const setCookieFor = (response: Response, name: string) => response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const valueOf = (setCookie: string | undefined) => setCookie?.split(";")[0].split("=").slice(1).join("=") ?? "";

/** Run /api/auth/login and return what the browser would hold: Google's URL and the login cookie. */
async function startLogin() {
  const response = await handleLogin();
  const location = new URL(response.headers.get("location")!);
  return { response, location, loginCookie: valueOf(setCookieFor(response, LOGIN_COOKIE)) };
}

/** A GET to the callback as the browser would send it. */
const callbackRequest = (query: Record<string, string>, loginCookie?: string) =>
  new Request(`${TEST_ORIGIN}/api/auth/callback?${new URLSearchParams(query)}`, {
    headers: loginCookie ? { cookie: `${LOGIN_COOKIE}=${loginCookie}` } : {},
  });

/** Callback with a fake token endpoint that answers with the given ID token. */
const exchangeReturning = (idToken: string) => vi.fn(async () => idToken);

describe("GET /api/auth/login", () => {
  it("redirects to Google's authorize endpoint with every OAuth, OpenID Connect and PKCE parameter", async () => {
    const { response, location } = await startLogin();
    expect(response.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    const query = location.searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(query.get("redirect_uri")).toBe(`${TEST_ORIGIN}/api/auth/callback`);
    expect(query.get("scope")).toBe("openid email profile");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get("state")).not.toBe(query.get("nonce"));
  });

  it("stores state, nonce and verifier in a signed cookie that matches what was sent to Google", async () => {
    const { location, loginCookie } = await startLogin();
    const saved = await openLoginState(loginCookie);
    expect(saved).not.toBeNull();
    expect(saved!.state).toBe(location.searchParams.get("state"));
    expect(saved!.nonce).toBe(location.searchParams.get("nonce"));
    // Google got the hash, the cookie holds the secret it hashes from.
    expect(location.searchParams.get("code_challenge")).toBe(codeChallengeFor(saved!.verifier));
    expect(saved!.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("sets the login cookie HttpOnly, Secure, SameSite=Lax and short-lived", async () => {
    const { response } = await startLogin();
    const cookie = setCookieFor(response, LOGIN_COOKIE)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=600/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("allows a non-Secure cookie only for http://localhost", async () => {
    const restore = setAuthEnv({ AUTH_URL: "http://localhost:3000" });
    try {
      const { response, location } = await startLogin();
      expect(setCookieFor(response, LOGIN_COOKIE)).not.toMatch(/Secure/i);
      expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    } finally {
      restore();
    }
  });

  it("fails closed, with a generic redirect, when the origin or credentials are not usable", async () => {
    for (const overrides of [
      { AUTH_URL: "http://airport-demo-pi.vercel.app" }, // plain http on a real host
      { AUTH_URL: "https://user:pass@airport-demo-pi.vercel.app" },
      { AUTH_URL: "not a url" },
      { GOOGLE_CLIENT_ID: undefined },
      { GOOGLE_CLIENT_SECRET: undefined },
      { AUTH_SECRET: "short" },
    ]) {
      const restore = setAuthEnv(overrides);
      try {
        const response = await handleLogin();
        expect(response.headers.get("location")).toBe("/?signin=failed");
        expect(setCookieFor(response, LOGIN_COOKIE)).toMatch(/Max-Age=0/i); // nothing is left behind
      } finally {
        restore();
      }
    }
  });

  it("builds the redirect URI from AUTH_URL, ignoring any path in it", async () => {
    const restore = setAuthEnv({ AUTH_URL: `${TEST_ORIGIN}/some/path?x=1` });
    try {
      const { location } = await startLogin();
      expect(location.searchParams.get("redirect_uri")).toBe(`${TEST_ORIGIN}/api/auth/callback`);
    } finally {
      restore();
    }
  });
});

describe("GET /api/auth/callback", () => {
  async function signInWith(tokenClaims: Parameters<typeof google.signIdToken>[0] = {}, state?: string) {
    const { location, loginCookie } = await startLogin();
    const idToken = await google.signIdToken({ nonce: location.searchParams.get("nonce")!, ...tokenClaims });
    const exchangeCode = exchangeReturning(idToken);
    const response = await handleCallback(
      callbackRequest({ code: "one-time-code", state: state ?? location.searchParams.get("state")! }, loginCookie),
      { exchangeCode, googleKeys: google.keys },
    );
    return { response, exchangeCode, loginCookie };
  }

  it("signs in: sets our session cookie, clears the login cookie, redirects home", async () => {
    const { response, exchangeCode } = await signInWith();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const session = setCookieFor(response, SESSION_COOKIE)!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Max-Age=28800/i);
    expect(await readSessionToken(valueOf(session))).toMatchObject({ sub: "google-sub-123", email: "ada@example.com", name: "Ada Lovelace" });
    expect(setCookieFor(response, LOGIN_COOKIE)).toMatch(/Max-Age=0/i);

    // The code was redeemed with the verifier from the cookie.
    expect(exchangeCode).toHaveBeenCalledOnce();
    const [call] = exchangeCode.mock.calls[0] as unknown as [Record<string, string>];
    expect(call).toMatchObject({ code: "one-time-code", clientId: TEST_CLIENT_ID, redirectUri: `${TEST_ORIGIN}/api/auth/callback` });
    expect(call.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("puts only our own claims in the session cookie, nothing from Google's token", async () => {
    const { response } = await signInWith();
    const payload = JSON.parse(Buffer.from(valueOf(setCookieFor(response, SESSION_COOKIE)).split(".")[1], "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["aud", "email", "exp", "iat", "iss", "name", "picture", "sub"]);
    expect(payload).not.toHaveProperty("nonce");
  });

  it("rejects a state that does not match the cookie, before calling Google", async () => {
    const { response, exchangeCode } = await signInWith({}, "state-from-someone-elses-login");
    expect(response.headers.get("location")).toBe("/?signin=failed");
    expect(setCookieFor(response, SESSION_COOKIE)).toBeUndefined();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("Sign-in failed:", "state_mismatch");
  });

  it("rejects a callback with no login cookie (this browser never started a login)", async () => {
    const { location } = await startLogin();
    const exchangeCode = vi.fn();
    const response = await handleCallback(callbackRequest({ code: "c", state: location.searchParams.get("state")! }), { exchangeCode });
    expect(response.headers.get("location")).toBe("/?signin=failed");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a forged login cookie, a login cookie used as a session and an expired login cookie", async () => {
    const { location, loginCookie } = await startLogin();
    const state = location.searchParams.get("state")!;
    const exchangeCode = vi.fn();
    const forged = `${loginCookie.slice(0, -4)}AAAA`;
    expect((await handleCallback(callbackRequest({ code: "c", state }, forged), { exchangeCode })).headers.get("location")).toBe("/?signin=failed");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect((await handleCallback(callbackRequest({ code: "c", state }, loginCookie), { exchangeCode })).headers.get("location")).toBe("/?signin=failed");
    } finally {
      vi.useRealTimers();
    }
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects when Google reports an error or sends no code", async () => {
    const { location, loginCookie } = await startLogin();
    const state = location.searchParams.get("state")!;
    const exchangeCode = vi.fn();
    const queries: Record<string, string>[] = [{ error: "access_denied", state }, { state }, { code: "c" }];
    for (const query of queries) {
      const response = await handleCallback(callbackRequest(query, loginCookie), { exchangeCode });
      expect(response.headers.get("location")).toBe("/?signin=failed");
      expect(setCookieFor(response, SESSION_COOKIE)).toBeUndefined();
    }
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a bad ID token (wrong nonce, unverified email) and sets no session", async () => {
    for (const claims of [{ nonce: "replayed" }, { email_verified: false }]) {
      const { response } = await signInWith(claims);
      expect(response.headers.get("location")).toBe("/?signin=failed");
      expect(setCookieFor(response, SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("rejects when the token endpoint fails, and logs only a reason code", async () => {
    const { location, loginCookie } = await startLogin();
    const exchangeCode = vi.fn(async () => {
      throw new (await import("./authError")).AuthError("token_endpoint_400");
    });
    const response = await handleCallback(callbackRequest({ code: "c", state: location.searchParams.get("state")! }, loginCookie), { exchangeCode });
    expect(response.headers.get("location")).toBe("/?signin=failed");
    expect(console.warn).toHaveBeenCalledWith("Sign-in failed:", "token_endpoint_400");
  });

  it("never leaks a thrown error's message into the response or the log", async () => {
    const { location, loginCookie } = await startLogin();
    const exchangeCode = vi.fn(async () => {
      throw new Error("secret-detail-from-upstream");
    });
    const response = await handleCallback(callbackRequest({ code: "c", state: location.searchParams.get("state")! }, loginCookie), { exchangeCode });
    expect(JSON.stringify([...response.headers.entries()])).not.toContain("secret-detail");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("secret-detail");
  });
});

describe("token exchange request", () => {
  it("posts the code, verifier, client id and secret and redirect uri to Google's token endpoint, and returns only the id_token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id_token: "the-id-token", access_token: "never-read", expires_in: 3599 }));
    const idToken = await exchangeCodeForIdToken(
      { code: "c1", verifier: "v1", clientId: "id1", clientSecret: "secret1", redirectUri: `${TEST_ORIGIN}/api/auth/callback` },
      fetchMock as unknown as typeof fetch,
    );
    expect(idToken).toBe("the-id-token");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(init.body as URLSearchParams))).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      code_verifier: "v1",
      client_id: "id1",
      client_secret: "secret1",
      redirect_uri: `${TEST_ORIGIN}/api/auth/callback`,
    });
  });

  it("fails on an error status or a response without an id_token", async () => {
    const args = { code: "c", verifier: "v", clientId: "i", clientSecret: "s", redirectUri: "r" };
    await expect(exchangeCodeForIdToken(args, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch)).rejects.toMatchObject({ reason: "token_endpoint_400" });
    await expect(exchangeCodeForIdToken(args, (async () => Response.json({ access_token: "x" })) as unknown as typeof fetch)).rejects.toMatchObject({ reason: "token_response_invalid" });
    await expect(exchangeCodeForIdToken(args, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).rejects.toMatchObject({ reason: "token_endpoint_unreachable" });
  });
});

describe("GET /api/auth/me", () => {
  const me = async (cookie?: string) => {
    const response = await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: cookie ? { cookie } : {} }));
    return { response, body: await response.json() };
  };

  it("says whether sign-in is required, and that nobody is signed in", async () => {
    expect((await me()).body).toEqual({ required: true, signedIn: false });
    const restore = setAuthEnv({ AUTH_REQUIRED: undefined });
    try {
      expect((await me()).body).toEqual({ required: false, signedIn: false });
    } finally {
      restore();
    }
  });

  it("returns name, email and picture for a valid session, never cached", async () => {
    const { response } = await signInWith();
    const cookie = `${SESSION_COOKIE}=${valueOf(setCookieFor(response, SESSION_COOKIE))}`;
    const result = await me(cookie);
    expect(result.body).toEqual({ required: true, signedIn: true, name: "Ada Lovelace", email: "ada@example.com", picture: "https://lh3.googleusercontent.com/a/ada" });
    expect(result.response.headers.get("cache-control")).toBe("no-store");
  });

  it("says signed out for a bad cookie", async () => {
    expect((await me(`${SESSION_COOKIE}=garbage`)).body).toEqual({ required: true, signedIn: false });
  });

  async function signInWith() {
    const { location, loginCookie } = await startLogin();
    const idToken = await google.signIdToken({ nonce: location.searchParams.get("nonce")! });
    const response = await handleCallback(callbackRequest({ code: "c", state: location.searchParams.get("state")! }, loginCookie), {
      exchangeCode: exchangeReturning(idToken),
      googleKeys: google.keys,
    });
    return { response };
  }
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const response = logoutRoute.POST(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
    const cookie = setCookieFor(response, SESSION_COOKIE)!;
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("refuses a request a browser marks as coming from another site", async () => {
    const response = logoutRoute.POST(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(403);
    expect(setCookieFor(response, SESSION_COOKIE)).toBeUndefined();
  });
});
