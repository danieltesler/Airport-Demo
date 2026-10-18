import { describe, expect, it } from "vitest";
import { micBlockedMessage } from "./micBlockedMessage";

describe("micBlockedMessage", () => {
  it("gives Chrome steps on Android Chrome", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";
    expect(micBlockedMessage(ua)).toContain("lock icon");
  });

  it("falls back to generic wording elsewhere", () => {
    expect(micBlockedMessage("Mozilla/5.0 (iPhone) AppleWebKit/605 Version/17 Safari/604")).not.toContain("Chrome");
    expect(micBlockedMessage("Mozilla/5.0 Firefox/128.0")).not.toContain("Chrome");
    expect(micBlockedMessage("")).not.toContain("Chrome");
  });
});
