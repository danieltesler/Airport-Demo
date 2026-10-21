import { describe, expect, it } from "vitest";
import { codeChallengeFor, randomToken, safeEqual } from "./pkce";

describe("PKCE code challenge", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is URL-safe base64 without padding", () => {
    expect(codeChallengeFor("any verifier at all")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("randomToken", () => {
  it("is URL-safe, long enough for a PKCE verifier, and different every time", () => {
    const verifier = randomToken(48);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/); // PKCE allows 43 to 128 characters
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("safeEqual", () => {
  it("is true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});
